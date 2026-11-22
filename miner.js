/**
 * miner.js — авто-шахта для «ямы» с висящими блоками (как /шахта на HolyWorld).
 *
 * Шахта — огороженная приватом яма, где в воздухе висят блоки камня и руды и
 * раз в несколько минут появляются заново. Поэтому:
 *  1. Центр шахты — место, где бота включили. Цели — только камень и руда
 *     (список targets) в радиусе radius от центра: стены, пол и лестницы не трогаем.
 *  2. Цель в досягаемости — бьём сразу (бур 3×3 снимает и соседей). Иначе
 *     подходим через pathfinder: падать можно, по лестницам лезть можно,
 *     копать по дороге — нельзя (вокруг приват).
 *  3. Блок не сломался/вернулся maxFails раз — это приват: запоминаем и больше не трогаем.
 *     Когда набралось успешных ударов, ищем только внутри «коробки», где ломалось.
 *  4. Шахта пуста — ждём обновления и продолжаем. Унесло (смерть, телепорт) — идём обратно.
 *  5. Сама шахта НЕ выключается: нет кирки, нечем чинить бур — пауза с сообщением
 *     и автоматическое продолжение, когда всё исправится. Выключает только игрок.
 *
 * Дроп не собираем: на кирке магнетизм. Все ожидания — с таймаутами.
 */

const { sleep, withTimeout } = require('./utils');

let pathfinderLib = null;
try {
  pathfinderLib = require('mineflayer-pathfinder');
} catch (_) {}

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'command_block', 'structure_block']);
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
const RESERVE_FOOD = new Set(['golden_apple', 'enchanted_golden_apple']);
const PICK_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];

// Что копаем в шахте.
const DEFAULT_TARGETS = [
  'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'mossy_cobblestone',
  'coal_ore', 'iron_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
  'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris',
];

// Что выбрасывать, когда инвентарь забит. Неизвестные предметы (ключи, сферы) не трогаем.
const DEFAULT_JUNK = [
  'cobblestone', 'stone', 'andesite', 'diorite', 'granite', 'dirt', 'gravel', 'flint',
  'netherrack', 'mossy_cobblestone',
];

const DEFAULTS = {
  radius: 10, // радиус шахты от центра по горизонтали
  above: 8, // насколько выше центра искать блоки
  below: 20, // насколько ниже центра
  reach: 4.3, // досягаемость удара от глаз до центра блока
  maxDrop: 64, // с какой высоты можно спрыгнуть (урона от падения нет)
  maxFails: 2, // столько раз блок не сломался — приват
  moveTimeoutMs: 12000, // сколько идти к блоку
  emptyRescanMs: 2000, // как часто проверять пустую шахту
  stuckMs: 60000, // нет ни одного удачного удара столько — встряхнуться
  pauseRetryMs: 10000, // как часто проверять, не исправилась ли причина паузы
  eatAt: 14, // есть при сытости ≤
  repairAt: 100, // чинить бур при прочности ≤
  minFreeSlots: 2, // выбрасывать мусор, когда свободных слотов ≤
  settleMs: null, // пауза на ответ сервера после удара; null — по пингу
  center: null, // центр шахты {x,y,z}; null — где стоит бот
  targets: DEFAULT_TARGETS,
  junk: DEFAULT_JUNK,
};

const posKey = (p) => `${p.x},${p.y},${p.z}`;
const isOre = (name) => name.endsWith('_ore') || name === 'ancient_debris';
const isLiquid = (b) => !!b && LIQUIDS.has(b.name);
const isPassable = (b) => !!b && b.boundingBox === 'empty' && !isLiquid(b);
const isUnbreakable = (b) => !b || UNBREAKABLE.has(b.name) || b.diggable === false || b.hardness === null;

function durabilityLeft(item) {
  if (!item || !item.maxDurability || item.durabilityUsed === undefined) return null;
  return item.maxDurability - item.durabilityUsed;
}

const itemText = (item) => `${item.customName || ''} ${item.displayName || ''}`.toLowerCase();
const isDrill = (item) => /бур|drill/.test(itemText(item));
const toolKeyOf = (item) => `${item.name}|${item.customName || ''}`;
const tierOf = (item) => {
  const i = PICK_TIERS.indexOf(item.name);
  return i === -1 ? PICK_TIERS.length : i;
};

class Miner {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{notify?: (t: string) => void, log?: (t: string) => void, options?: object}} [hooks]
   */
  constructor(bot, { notify = () => {}, log = () => {}, options = {} } = {}) {
    this.bot = bot;
    this.notify = notify;
    this.log = log;
    const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== null));
    this.opt = { ...DEFAULTS, ...clean };
    this.running = false;
    this.runId = 0;
    this.stopReason = null;
    /** @type {((reason: string) => void) | null} */
    this.onStop = null;
    this.center = null;
    this.state = 'старт';
    this.protectedBlocks = new Set(); // приват — не трогаем до конца сессии
    this.fails = new Map(); // сколько раз блок не сломался
    this.skipUntil = new Map(); // временно недостижимые блоки
    this.goodBox = null; // где реально ломается — так узнаём границы шахты
    this.goodCount = 0;
    this.pausedWhy = null;
    this.emptySince = 0;
    this.lastDigAt = 0;
    this.lastTossAt = 0;
    this.warnedAt = {};
    this.toolKey = null;
    this.stats = { blocks: 0, ores: 0, startedAt: 0 };
  }

  // ─── Управление ─────────────────────────────────────────────────────────────

  start() {
    if (this.running) return false;
    const id = ++this.runId;
    this.running = true;
    this.stopReason = null;
    this.stats = { blocks: 0, ores: 0, startedAt: Date.now() };
    this._loop(id)
      .catch((err) => this.log(`ошибка шахты: ${(err && err.stack) || err}`))
      .finally(() => {
        if (id === this.runId) this.running = false;
        try {
          this.bot.pathfinder && this.bot.pathfinder.setGoal(null);
          this.bot.clearControlStates();
        } catch (_) {}
        if (this.onStop) this.onStop(this.stopReason || 'остановлено');
      });
    return true;
  }

  stop(reason = 'остановлено') {
    if (!this.running) return;
    this.running = false;
    this.stopReason = reason;
    try {
      this.bot.stopDigging();
    } catch (_) {}
    try {
      if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
    } catch (_) {}
  }

  alive(id) {
    return this.running && id === this.runId;
  }

  summary() {
    const s = this.stats;
    const mins = Math.max((Date.now() - s.startedAt) / 60000, 1 / 60);
    return `сломано ${s.blocks} (руды ${s.ores}), ${Math.round(s.blocks / mins)}/мин, приват-блоков ${this.protectedBlocks.size}`;
  }

  shortStatus() {
    return `${this.state}, сломано ${this.stats.blocks}`;
  }

  // ─── Главный цикл: работает, пока игрок не выключит ────────────────────────

  async _loop(id) {
    const bot = this.bot;
    this._setupMovements();
    const here = bot.entity.position.floored();
    const c = this.opt.center;
    this.center = c ? here.offset(c.x - here.x, c.y - here.y, c.z - here.z) : here;
    this.lastDigAt = Date.now();
    this.notify(`⛏ Шахта включена: центр ${posKey(this.center)}, радиус ${this.opt.radius}`);

    while (this.alive(id)) {
      try {
        await this._step(id);
      } catch (err) {
        this.log(`шаг шахты: ${err && err.message}`);
        await sleep(1000);
      }
    }
  }

  async _step(id) {
    const bot = this.bot;
    if (!bot.entity || bot.health <= 0 || bot.isAlive === false) {
      this.state = 'ждёт возрождения';
      await sleep(1000);
      return;
    }
    if (!(await this._maintain(id))) {
      await sleep(this.opt.pauseRetryMs); // пауза: ждём, пока появится кирка/пузырьки
      return;
    }

    // Унесло от шахты (смерть, телепорт) — идём обратно.
    if (!this._nearMine(bot.entity.position.floored(), 4)) {
      this.state = 'идёт к шахте';
      if (!(await this._goNear(this.center, 2))) {
        this._warn('far', `🚶 Не могу дойти до шахты ${posKey(this.center)} — пробую ещё раз`, 60000);
        await sleep(5000);
      }
      return;
    }

    // Давно ничего не ломалось, хотя шахта не пуста — встряхнуться.
    if (!this.emptySince && Date.now() - this.lastDigAt > this.opt.stuckMs) {
      this.log('давно нет удачных ударов — сбрасываю пропуски и иду в центр');
      this.lastDigAt = Date.now();
      this.skipUntil.clear();
      await this._goNear(this.center, 2);
      return;
    }

    const target = this._pickTarget();
    if (!target) {
      this.state = 'ждёт обновления шахты';
      if (!this.emptySince) {
        this.emptySince = Date.now();
        this.notify(`⏳ Шахта пуста — жду обновления (${this.summary()})`);
      }
      this.skipUntil.clear();
      await sleep(this.opt.emptyRescanMs);
      return;
    }
    if (this.emptySince) {
      if (Date.now() - this.emptySince > 10000) this.notify('♻️ Шахта обновилась — копаю');
      this.emptySince = 0;
      this.lastDigAt = Date.now();
    }

    this.state = 'копает';
    if (this._eyeDist(target.position) > this.opt.reach) {
      const moved = await this._goNear(target.position, 3);
      if (!this.alive(id)) return;
      if (!moved || this._eyeDist(target.position) > this.opt.reach + 0.5) {
        this.skipUntil.set(posKey(target.position), Date.now() + 30000);
        return;
      }
    }
    await this._mine(target);
  }

  // ─── Цели ───────────────────────────────────────────────────────────────────

  _inRegion(p) {
    const c = this.center;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const dy = p.y - c.y;
    if (dx * dx + dz * dz > this.opt.radius * this.opt.radius) return false;
    if (dy > this.opt.above || dy < -this.opt.below) return false;
    // Когда уже ясно, где реально ломается, — только там (с запасом).
    const g = this.goodBox;
    if (g && this.goodCount >= 8) {
      const m = 3;
      if (p.x < g.minX - m || p.x > g.maxX + m || p.y < g.minY - m || p.y > g.maxY + m || p.z < g.minZ - m || p.z > g.maxZ + m) return false;
    }
    return true;
  }

  _nearMine(p, margin) {
    const c = this.center;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const r = this.opt.radius + margin;
    const dy = p.y - c.y;
    return dx * dx + dz * dz <= r * r && dy <= this.opt.above + margin && dy >= -this.opt.below - margin;
  }

  _pickTarget() {
    const bot = this.bot;
    const reg = bot.registry && bot.registry.blocksByName;
    const ids = this.opt.targets.map((n) => reg && reg[n] && reg[n].id).filter((x) => x !== undefined && x !== null);
    if (!ids.length) return null;
    const found = bot.findBlocks({
      point: this.center,
      matching: ids,
      maxDistance: Math.max(this.opt.radius, this.opt.below, this.opt.above) + 2,
      count: 600,
    });
    const now = Date.now();
    let best = null;
    let bestScore = Infinity;
    for (const p of found) {
      const k = posKey(p);
      if (this.protectedBlocks.has(k)) continue;
      if ((this.skipUntil.get(k) || 0) > now) continue;
      if (!this._inRegion(p)) continue;
      const b = this._block(p);
      if (!b || isUnbreakable(b) || this._nearLiquid(p)) continue;
      const dist = this._eyeDist(p);
      let score = dist;
      if (dist <= this.opt.reach) score -= 100; // сначала всё, что достаём не сходя с места
      if (isOre(b.name)) score -= 1.5; // руда дороже
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  _nearLiquid(p) {
    const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    return n.some(([x, y, z]) => isLiquid(this._block(p.offset(x, y, z))));
  }

  // ─── Удар ───────────────────────────────────────────────────────────────────

  async _mine(block) {
    const pos = block.position;
    const name = block.name;
    const k = posKey(pos);
    let res = await this._dig(block, 'raycast');
    if (res === 'notInView') res = await this._dig(this._block(pos) || block, 'auto');
    await this._settle();

    const after = this._block(pos);
    if (after && after.name === name) {
      // Не сломался или сервер вернул блок обратно.
      const n = (this.fails.get(k) || 0) + 1;
      this.fails.set(k, n);
      if (n >= this.opt.maxFails) {
        this.protectedBlocks.add(k);
        this.fails.delete(k);
        this.log(`${name} ${k} не ломается — приват, больше не трогаю`);
      } else {
        this.skipUntil.set(k, Date.now() + 3000);
      }
      return false;
    }
    this.fails.delete(k);
    if (res !== 'ok' && after && !isPassable(after)) return false;
    this.stats.blocks++;
    if (isOre(name)) this.stats.ores++;
    this.lastDigAt = Date.now();
    this._remember(pos);
    return true;
  }

  _remember(p) {
    this.goodCount++;
    const g = this.goodBox;
    if (!g) {
      this.goodBox = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y, minZ: p.z, maxZ: p.z };
      return;
    }
    g.minX = Math.min(g.minX, p.x);
    g.maxX = Math.max(g.maxX, p.x);
    g.minY = Math.min(g.minY, p.y);
    g.maxY = Math.max(g.maxY, p.y);
    g.minZ = Math.min(g.minZ, p.z);
    g.maxZ = Math.max(g.maxZ, p.z);
  }

  /** @returns {Promise<'ok'|'notInView'|'fail'>} */
  async _dig(block, face) {
    const bot = this.bot;
    let time = 1000;
    try {
      time = bot.digTime(block);
    } catch (_) {}
    if (!Number.isFinite(time)) return 'fail';
    try {
      await withTimeout(bot.dig(block, true, face), time + 3000, 'копание');
      return 'ok';
    } catch (err) {
      try {
        bot.stopDigging();
      } catch (_) {}
      if (err && /not in view/i.test(err.message)) return 'notInView';
      this.log(`не сломал ${block.name}: ${err && err.message}`);
      return 'fail';
    }
  }

  _settle() {
    if (this.opt.settleMs != null) return sleep(this.opt.settleMs);
    const ping = (this.bot.player && this.bot.player.ping) || 50;
    return sleep(Math.min(Math.max(ping + 60, 80), 450));
  }

  // ─── Движение (pathfinder: без копания, с падениями и лестницами) ──────────

  _setupMovements() {
    const bot = this.bot;
    if (!bot.pathfinder || !pathfinderLib) return;
    try {
      const moves = new pathfinderLib.Movements(bot);
      moves.canDig = false; // вокруг приват — дорогу не прокапываем
      moves.allowParkour = false;
      moves.allow1by1towers = false;
      moves.scafoldingBlocks = [];
      moves.maxDropDown = this.opt.maxDrop;
      bot.pathfinder.setMovements(moves);
      bot.pathfinder.thinkTimeout = 3000;
    } catch (err) {
      this.log(`движения pathfinder: ${err.message}`);
    }
  }

  async _goNear(pos, range) {
    const bot = this.bot;
    if (!bot.pathfinder || !pathfinderLib) return false;
    const goal = new pathfinderLib.goals.GoalNear(pos.x, pos.y, pos.z, range);
    try {
      await withTimeout(bot.pathfinder.goto(goal), this.opt.moveTimeoutMs, 'путь');
      return true;
    } catch (err) {
      this.log(`не дошёл до ${posKey(pos)}: ${err && err.message}`);
      return false;
    } finally {
      try {
        bot.pathfinder.setGoal(null); // жёсткая остановка, а не «мягкий» stop()
        bot.clearControlStates();
      } catch (_) {}
    }
  }

  _eyeDist(p) {
    const e = this.bot.entity.position;
    const dx = p.x + 0.5 - e.x;
    const dy = p.y + 0.5 - (e.y + 1.62);
    const dz = p.z + 0.5 - e.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _block(p) {
    return this.bot.blockAt(p, false);
  }

  async _equip(item, dest) {
    const bot = this.bot;
    if (dest === 'hand' && bot.heldItem && bot.heldItem.slot === item.slot) return true;
    try {
      await withTimeout(bot.equip(item, dest), 5000, 'экипировка');
      return true;
    } catch (err) {
      this.log(`не взял ${item.name}: ${err.message}`);
      return false;
    }
  }

  // ─── Обслуживание: кирка, починка, еда, мусор, сфера ────────────────────────

  /** false — пауза (причину пишем в Telegram один раз), шахта сама продолжит позже. */
  async _maintain(id) {
    const bot = this.bot;
    const tool = this._findTool();
    if (!tool) return this._pause('нет кирки/бура в инвентаре');
    await this._equip(tool, 'hand');

    const left = durabilityLeft(bot.heldItem);
    if (left !== null && left <= this.opt.repairAt) {
      await this._repair(id);
      const now = durabilityLeft(bot.heldItem);
      if (now !== null && now <= this.opt.repairAt) {
        return this._pause(`бур почти сломан (${now}), а починить нечем — положите пузырьки опыта`);
      }
    }
    if (bot.food <= this.opt.eatAt) await this._eat();
    if (bot.inventory.emptySlotCount() <= this.opt.minFreeSlots && Date.now() - this.lastTossAt > 20000) {
      await this._tossJunk();
    }
    await this._ensureHead();

    if (this.pausedWhy) {
      this.notify('▶️ Шахта продолжает работу');
      this.pausedWhy = null;
      this.lastDigAt = Date.now();
    }
    return this.alive(id);
  }

  _pause(why) {
    this.state = `пауза: ${why}`;
    if (this.pausedWhy !== why) {
      this.pausedWhy = why;
      this.notify(`⏸ Шахта на паузе: ${why}. Продолжу сама, когда исправится`);
    }
    return false;
  }

  /** Кирка в руке, если она есть; иначе бур по названию; иначе лучшая по материалу. */
  _findTool() {
    const bot = this.bot;
    const held = bot.heldItem;
    if (held && held.name.endsWith('_pickaxe') && (!this.toolKey || toolKeyOf(held) === this.toolKey)) {
      this.toolKey = toolKeyOf(held);
      return held;
    }
    const picks = bot.inventory.items().filter((i) => i.name.endsWith('_pickaxe'));
    if (!picks.length) return null;
    const pick =
      (this.toolKey && picks.find((i) => toolKeyOf(i) === this.toolKey)) ||
      picks.find(isDrill) ||
      picks.slice().sort((a, b) => tierOf(a) - tierOf(b))[0];
    this.toolKey = toolKeyOf(pick);
    return pick;
  }

  /** Пузырьки опыта из левой руки под ноги, пока «Починка» не вернёт прочность. */
  async _repair(id) {
    const bot = this.bot;
    const findBottle = () => bot.inventory.items().find((i) => i.name === 'experience_bottle');
    if (!findBottle()) return false;
    const max = bot.heldItem.maxDurability;
    let best = durabilityLeft(bot.heldItem);
    this.state = 'чинит бур';
    this.notify(`♻️ Чиню бур (осталось ${best})...`);
    try {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true); // в mineflayer −π/2 — строго вниз
    } catch (_) {}

    let idle = 0;
    while (this.alive(id)) {
      const cur = durabilityLeft(bot.heldItem);
      if (cur === null || cur >= max - 20) break;
      if (cur > best) {
        best = cur;
        idle = 0;
      } else if (++idle > 15) {
        this.notify('⚠️ Пузырьки не чинят бур — на нём есть «Починка»?');
        break;
      }
      const off = bot.inventory.slots[45];
      if (!off || off.name !== 'experience_bottle') {
        const b = findBottle();
        if (!b || !(await this._equip(b, 'off-hand'))) break;
      }
      bot.activateItem(true);
      await sleep(150);
    }
    try {
      bot.deactivateItem();
    } catch (_) {}
    await this._ensureHead();
    const after = durabilityLeft(bot.heldItem);
    this.notify(`✅ Починка закончена: ${after}/${max}`);
    return after !== null && after > this.opt.repairAt;
  }

  async _eat() {
    const bot = this.bot;
    const foods = (bot.registry && bot.registry.foodsByName) || {};
    const list = bot.inventory.items().filter((i) => foods[i.name] && !BAD_FOOD.has(i.name));
    if (!list.length) {
      this._warn('food', '🍖 Голод, а еды в инвентаре нет');
      return;
    }
    const score = (i) =>
      (RESERVE_FOOD.has(i.name) ? -100 : 0) + (foods[i.name].foodPoints || 0) + (foods[i.name].saturation || 0);
    list.sort((a, b) => score(b) - score(a));
    if (await this._equip(list[0], 'hand')) {
      try {
        await bot.consume();
      } catch (err) {
        this.log(`еда: ${err.message}`);
      }
    }
    const tool = this._findTool();
    if (tool) await this._equip(tool, 'hand');
  }

  async _tossJunk() {
    const bot = this.bot;
    this.lastTossAt = Date.now();
    const junk = new Set(this.opt.junk);
    const list = bot.inventory.items().filter((i) => junk.has(i.name));
    if (!list.length) {
      this._warn('full', '🎒 Инвентарь забит, а мусора нет — пора разгрузить бота');
      return;
    }
    for (const item of list) {
      if (!this.running) break;
      try {
        await withTimeout(bot.tossStack(item), 4000, 'выброс');
      } catch (_) {}
    }
    const tool = this._findTool();
    if (tool) await this._equip(tool, 'hand');
  }

  /** Сфера (голова) — в левую руку; пузырьки после починки — убрать. */
  async _ensureHead() {
    const bot = this.bot;
    const off = bot.inventory.slots[45];
    if (off && off.name === 'player_head') return;
    const head = bot.inventory.items().find((i) => i.name === 'player_head');
    if (head) {
      await this._equip(head, 'off-hand');
    } else if (off && off.name === 'experience_bottle') {
      try {
        await withTimeout(bot.unequip('off-hand'), 5000, 'снять');
      } catch (_) {}
    }
  }

  _warn(key, text, everyMs = 120000) {
    const now = Date.now();
    if (now - (this.warnedAt[key] || 0) < everyMs) return;
    this.warnedAt[key] = now;
    this.notify(text);
  }
}

module.exports = { Miner, DEFAULTS, DEFAULT_TARGETS, DEFAULT_JUNK, durabilityLeft };
