/**
 * miner.js — авто-шахта «карьер змейкой» под бур 3×3.
 *
 * Как копает:
 *  1. Бот смотрит по стороне света и бьёт блок на уровне головы гранью к себе.
 *     Бур снимает стенку 3×3 (3 в ширину, 3 в высоту), бот делает шаг вперёд.
 *     Сразу рубится до `lookahead` стенок вперёд, потом один проход ногами —
 *     так меньше остановок и почти нет ожидания сервера.
 *  2. Упёрся (бедрок, барьер, приват, лава/вода рядом, обрыв) — сдвиг на 3 блока
 *     вбок и обратно по соседнему ряду. Ряды встают вплотную, без пропусков.
 *  3. Вбок тоже некуда — слой закончен: спуск на `layerDepth` блоков и новый слой
 *     в обратную сторону. Вниз некуда (бедрок) — шахта пройдена, стоп.
 *  4. Стартовал на поверхности (на этом слое ещё ничего не копал, а впереди
 *     `airRunToDescend` шагов пустоты) — сразу спускается, а не гуляет по верху.
 *
 * Без бура всё работает так же, просто туннель 1×2 (два удара на шаг).
 *
 * Чего здесь нарочно нет: pathfinder. В прямом туннеле он не нужен, а его
 * «мягкий» stop() и собственный детектор застревания были главной причиной
 * зависаний старой шахты. Каждое ожидание ограничено таймаутом, а сторож
 * останавливает шахту, если прогресса нет дольше `noProgressMs`.
 *
 * Дроп не собираем: на кирке магнетизм.
 */

const { sleep, withTimeout } = require('./utils');

// Стороны света в системе mineflayer (север = −Z). Индексы идут по часовой стрелке.
const DIRS = [
  { x: 0, z: -1, name: 'север' },
  { x: 1, z: 0, name: 'восток' },
  { x: 0, z: 1, name: 'юг' },
  { x: -1, z: 0, name: 'запад' },
];

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);
const UNBREAKABLE = new Set([
  'bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'end_gateway', 'nether_portal',
  'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block',
  'jigsaw', 'moving_piston', 'light',
]);
const GRAVITY = new Set(['sand', 'red_sand', 'gravel']);
const BAD_FLOOR = new Set([
  'magma_block', 'campfire', 'soul_campfire', 'fire', 'soul_fire', 'cactus',
  'sweet_berry_bush', 'wither_rose', 'cobweb', 'powder_snow',
]);
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
const RESERVE_FOOD = new Set(['golden_apple', 'enchanted_golden_apple']);
const PICK_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'creeper', 'spider',
  'cave_spider', 'silverfish', 'endermite', 'slime', 'magma_cube', 'witch', 'blaze',
  'piglin', 'piglin_brute', 'zoglin', 'hoglin', 'zombified_piglin', 'pillager', 'vindicator',
]);

// Что выбрасывать, когда инвентарь забит. Только заведомый мусор: неизвестные
// предметы (ключи, сферы, кастомные вещи сервера) бот не трогает.
const DEFAULT_JUNK = [
  'cobblestone', 'stone', 'andesite', 'diorite', 'granite', 'dirt', 'coarse_dirt', 'gravel',
  'flint', 'sand', 'red_sand', 'sandstone', 'netherrack', 'blackstone', 'basalt', 'tuff',
  'deepslate', 'cobbled_deepslate', 'calcite', 'smooth_basalt',
];

const DEFAULTS = {
  lookahead: 3, // сколько стенок рубить вперёд за один заход
  laneLength: 0, // длина ряда; 0 — до упора
  laneShift: 3, // сдвиг между рядами (ширина бура)
  layerDepth: 3, // спуск между слоями (высота бура)
  airRunToDescend: 6, // столько шагов по пустоте подряд — и спуск
  maxDrop: 3, // с какой высоты можно спрыгнуть (без урона от падения — хоть 64)
  maxFails: 3, // столько раз блок не сломался/вернулся — считаем его приватом
  eatAt: 14, // есть при сытости ≤
  repairAt: 100, // чинить бур при прочности ≤
  minFreeSlots: 2, // выбрасывать мусор, когда свободных слотов ≤
  noProgressMs: 30000, // сторож: столько без продвижения — стоп
  settleMs: null, // пауза на ответ сервера после ударов; null — по пингу
  junk: DEFAULT_JUNK,
};

const posKey = (p) => `${p.x},${p.y},${p.z}`;

function isWaterlogged(b) {
  try {
    return !!(b.getProperties && b.getProperties().waterlogged);
  } catch (_) {
    return false;
  }
}

const isLiquid = (b) => !!b && (LIQUIDS.has(b.name) || isWaterlogged(b));
const isPassable = (b) => !!b && b.boundingBox === 'empty' && !isLiquid(b) && b.name !== 'cobweb';
const isSolid = (b) => !!b && b.boundingBox === 'block';
const isGravity = (b) => !!b && (GRAVITY.has(b.name) || b.name.endsWith('_concrete_powder'));
const isUnbreakable = (b) =>
  !b || UNBREAKABLE.has(b.name) || b.diggable === false || b.hardness === null || b.hardness < 0;

function durabilityLeft(item) {
  if (!item || !item.maxDurability || item.durabilityUsed === undefined) return null;
  return item.maxDurability - item.durabilityUsed;
}

/** Ближайшая сторона света к взгляду бота. */
function dirFromYaw(yaw) {
  const vx = -Math.sin(yaw);
  const vz = -Math.cos(yaw);
  if (Math.abs(vx) > Math.abs(vz)) return vx > 0 ? 1 : 3;
  return vz > 0 ? 2 : 0;
}

function itemText(item) {
  return `${item.customName || ''} ${item.displayName || ''}`.toLowerCase();
}
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
    const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.opt = { ...DEFAULTS, ...clean };
    this.running = false;
    this.runId = 0;
    this.stopReason = null;
    /** @type {((reason: string) => void) | null} */
    this.onStop = null;
    this.dir = 0; // куда идёт ряд
    this.shiftDir = 1; // куда сдвигаемся между рядами — сторона света, а не «вправо от взгляда»
    this.fails = new Map();
    this.layerDigs = 0; // ударов на текущем слое (0 — бот ещё на поверхности)
    this.downWhy = null; // почему не удалось спуститься
    this.teleported = false;
    this.lastProgressAt = 0;
    this.lastTossAt = 0;
    this.warnedAt = {};
    this.toolKey = null;
    this.stats = { digs: 0, steps: 0, lanes: 0, layers: 0, setbacks: 0, startedAt: 0 };
  }

  // ─── Управление ─────────────────────────────────────────────────────────────

  start() {
    if (this.running) return false;
    const id = ++this.runId;
    const bot = this.bot;
    this.running = true;
    this.stopReason = null;
    this.stats = { digs: 0, steps: 0, lanes: 0, layers: 0, setbacks: 0, startedAt: Date.now() };
    const onForcedMove = () => {
      this.teleported = true;
    };
    bot.on('forcedMove', onForcedMove);

    this._loop(id)
      .catch((err) => {
        this.log(`ошибка шахты: ${(err && err.stack) || err}`);
        if (this.alive(id)) this.stop(`ошибка: ${err && err.message}`);
      })
      .finally(() => {
        bot.removeListener('forcedMove', onForcedMove);
        if (id === this.runId) {
          this.running = false;
          try {
            bot.clearControlStates();
          } catch (_) {}
        }
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
      this.bot.clearControlStates();
    } catch (_) {}
  }

  /**
   * Жив ли запуск id. Здесь же сторож: проверка зовётся после каждого ожидания,
   * поэтому зависшая на месте шахта останавливается даже посреди длинного шага.
   */
  alive(id) {
    if (this.running && Date.now() - this.lastProgressAt > this.opt.noProgressMs) {
      this.stop(`нет продвижения ${Math.round(this.opt.noProgressMs / 1000)} с — застрял`);
    }
    return this.running && id === this.runId;
  }

  summary() {
    const s = this.stats;
    const mins = Math.max((Date.now() - s.startedAt) / 60000, 1 / 60);
    return `шагов ${s.steps} (${Math.round(s.steps / mins)}/мин), ударов ${s.digs}, рядов ${s.lanes}, слоёв ${s.layers}`;
  }

  shortStatus() {
    return `${DIRS[this.dir].name}, слой ${this.stats.layers + 1}, шагов ${this.stats.steps}`;
  }

  // ─── Главный цикл ───────────────────────────────────────────────────────────

  async _loop(id) {
    const bot = this.bot;
    if (bot.pathfinder) bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    this.dir = dirFromYaw(bot.entity.yaw);
    this.shiftDir = (this.dir + 1) % 4; // первый сдвиг — вправо от начального взгляда
    this.layerDigs = 0;
    this._progress();

    if (!(await this._maintain(id))) return;
    await this._walkTo(this._feet(), { precise: true });
    this.notify(`⛏ Шахта: копаю на ${DIRS[this.dir].name}, ряды сдвигаю на ${DIRS[this.shiftDir].name}, слои по ${this.opt.layerDepth} вниз`);

    let laneSteps = 0;
    let airRun = 0;
    let stuck = 0;
    let waits = 0;
    let lastFeet = this._feet();

    while (this.alive(id)) {
      if (!(await this._maintain(id))) break;

      if (this.teleported) {
        // Откат античита или сброс шахты: продолжаем с того места, куда поставили.
        this.teleported = false;
        this.stats.setbacks++;
        await sleep(300);
        const jump = this._feet().distanceTo(lastFeet);
        if (jump > 5) {
          // Скорее всего сброс шахты: бота выкинуло наверх — разрешаем сразу спуститься.
          this.notify(`↪️ Сервер переместил бота на ${Math.round(jump)} бл. — копаю отсюда`);
          this.layerDigs = 0;
        }
        this.fails.clear();
        laneSteps = 0;
        airRun = 0;
        await this._walkTo(this._feet(), { precise: true });
        lastFeet = this._feet();
        continue;
      }
      lastFeet = this._feet();

      const capped = this.opt.laneLength > 0 && laneSteps >= this.opt.laneLength;
      const res = capped
        ? { status: 'blocked', reason: 'конец ряда' }
        : await this._advance(id, this.opt.lookahead);
      if (!this.alive(id)) break;

      if (res.status === 'progress') {
        laneSteps += res.steps;
        stuck = 0;
        waits = 0;
        airRun = res.dug > 0 ? 0 : airRun + res.steps;
        // Только пока на слое ничего не копали: пустота в своих же рядах или в пещере — норма.
        if (this.opt.airRunToDescend > 0 && this.layerDigs === 0 && airRun >= this.opt.airRunToDescend) {
          airRun = 0;
          await this._descendLayer(id);
        }
        continue;
      }
      if (res.status === 'wait' && ++waits <= 20) {
        await sleep(500); // чанки ещё грузятся
        continue;
      }
      if (res.status === 'stuck' && ++stuck <= 2) {
        await this._unstick();
        continue;
      }

      // Упёрлись — змейка: сдвиг вбок и обратно, иначе новый слой.
      stuck = 0;
      waits = 0;
      laneSteps = 0;
      airRun = 0;
      if (await this._shift(id)) {
        this.dir = (this.dir + 2) % 4;
        this.stats.lanes++;
        continue;
      }
      if (!this.alive(id)) break;
      if (await this._descendLayer(id)) {
        // Новый слой начинаем из угла: назад вдоль ряда, сдвиги — в обратную сторону.
        this.dir = (this.dir + 2) % 4;
        this.shiftDir = (this.shiftDir + 2) % 4;
        continue;
      }
      if (!this.alive(id)) break;
      this.stop(`шахта пройдена: вперёд — ${res.reason || 'тупик'}, вниз — ${this.downWhy || 'нельзя'}`);
    }
  }

  // ─── Движение по ряду ───────────────────────────────────────────────────────

  /**
   * Рубит до maxSlices стенок вперёд, проверяет, что сервер их реально сломал,
   * и проходит до последней открытой.
   */
  async _advance(id, maxSlices) {
    const d = DIRS[this.dir];
    const start = this._feet();
    const slices = [];
    for (let k = 1; k <= maxSlices; k++) {
      const c = start.offset(d.x * k, 0, d.z * k);
      const danger = this._danger(c, d);
      const floor = danger ? null : this._floor(c);
      const reason = danger || (floor && floor.blocked);
      if (reason) {
        if (k === 1) return reason === 'не прогружено' ? { status: 'wait' } : { status: 'blocked', reason };
        break;
      }
      slices.push({ c, drop: floor.drop });
      if (floor.drop > 0) break; // за обрывом дальше не планируем
    }

    const { open, dug, why } = await this._openSlices(id, slices, d);
    if (!this.alive(id)) return { status: 'stopped' };
    if (open === 0) return { status: 'blocked', reason: why || 'нет прохода', dug };

    const ok = await this._walkTo(slices[open - 1].c, { drop: slices[open - 1].drop });
    if (!ok) return { status: 'stuck', dug };
    this.stats.steps += open;
    this._progress();
    return { status: 'progress', steps: open, dug };
  }

  /**
   * Проходы по срезам: в каждом бьём первый мешающий блок (голова, потом ноги),
   * затем ждём ответ сервера. С буром хватает одного прохода. Возвращает,
   * сколько срезов подряд от бота реально открыты.
   */
  async _openSlices(id, slices, d) {
    const faceToMe = { x: -d.x, y: 0, z: -d.z }; // бур снимет вертикальную стенку 3×3
    const faceTop = { x: 0, y: 1, z: 0 }; // по ногам — сверху, чтобы бур не трогал пол
    let limit = slices.length;
    let dug = 0;
    let why = null;

    for (let round = 0; round < 8 && this.alive(id); round++) {
      let dugNow = 0;
      for (let i = 0; i < limit && this.alive(id); i++) {
        const c = slices[i].c;
        const head = c.offset(0, 1, 0);
        const hb = this._block(head);
        let target = null;
        if (!isPassable(hb)) {
          target = { pos: head, block: hb, face: faceToMe };
        } else {
          const fb = this._block(c);
          if (!isPassable(fb)) target = { pos: c, block: fb, face: faceTop };
        }
        if (!target) continue;

        const name = target.block ? target.block.name : '?';
        const gravity = isGravity(target.block);
        if (isUnbreakable(target.block)) why = `стена (${name})`;
        else if (isLiquid(target.block)) why = `жидкость (${name})`;
        else if (!gravity && this._failCount(target.pos) >= this.opt.maxFails) why = `${name} возвращается — приват?`;
        if (why) {
          limit = i;
          break;
        }
        if (!gravity) this._addFail(target.pos);
        if (!(await this._dig(target.block, target.face))) {
          why = `не ломается (${name})`;
          limit = i;
          break;
        }
        dugNow++;
      }
      dug += dugNow;
      if (dugNow === 0) break;
      await this._settle(); // ждём, пока сервер пришлёт остальные 8 блоков бура или откатит удар
    }

    let open = 0;
    while (open < limit && this._isOpen(slices[open].c)) open++;
    return { open, dug, why };
  }

  /** Сдвиг на соседний ряд. */
  async _shift(id) {
    const back = this.dir;
    this.dir = this.shiftDir;
    let moved = 0;
    let tries = 0;
    while (moved < this.opt.laneShift && this.alive(id) && tries++ < 8) {
      const res = await this._advance(id, Math.min(this.opt.lookahead, this.opt.laneShift - moved));
      if (res.status === 'progress') {
        moved += res.steps;
      } else if (res.status === 'wait') {
        await sleep(500);
      } else if (res.status === 'stuck') {
        await this._unstick();
      } else {
        break;
      }
    }
    this.dir = back;
    return moved > 0;
  }

  // ─── Спуск ──────────────────────────────────────────────────────────────────

  async _descendLayer(id) {
    if (!(await this._walkTo(this._feet(), { precise: true }))) return false;
    let went = 0;
    for (let i = 0; i < this.opt.layerDepth && this.alive(id); i++) {
      if (!(await this._descendOne(id))) break;
      went++;
    }
    if (went > 0) {
      this.stats.layers++;
      this.layerDigs = 0;
      this.fails.clear();
      this._progress();
      this.log(`слой ${this.stats.layers + 1}, y=${this._feet().y}`);
    }
    return went > 0;
  }

  /**
   * Бьёт блок под ногами сверху (бур снимает 3×3 под ботом) и ждёт приземления.
   * Почему спуститься нельзя — кладёт в this.downWhy.
   */
  async _descendOne(id) {
    const f = this._feet();
    const below = f.offset(0, -1, 0);
    const no = (why) => {
      this.downWhy = why;
      return false;
    };
    const under = this._block(below);
    if (isUnbreakable(under)) return no(`внизу ${under ? under.name : '?'}`);
    // Под ногами и вокруг не должно быть жидкостей: после удара они потекут к боту.
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cells = [below.offset(dx, 0, dz)];
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) cells.push(below.offset(dx, -1, dz), f.offset(dx, 0, dz));
        for (const p of cells) {
          if (!this._inWorld(p.y)) return no('край мира');
          const b = this._block(p);
          if (!b) return no('не прогружено');
          if (isLiquid(b)) return no(`рядом ${b.name}`);
        }
      }
    }
    const land = this._floor(below);
    if (land.blocked) return no(land.blocked);

    for (let i = 0; i < this.opt.maxFails && !isPassable(this._block(below)); i++) {
      if (!this.alive(id)) return false;
      const cur = this._block(below);
      if (isUnbreakable(cur)) return no(`внизу ${cur ? cur.name : '?'}`);
      if (!(await this._dig(cur, { x: 0, y: 1, z: 0 }))) return no(`не ломается ${cur.name}`);
      await this._settle();
    }
    if (!isPassable(this._block(below))) return no('блок под ногами возвращается — приват?');

    const targetY = below.y - land.drop;
    const landed = await this._waitUntil(
      () => this.bot.entity.onGround && this.bot.entity.position.y < targetY + 0.1,
      3000 + land.drop * 150,
    );
    if (landed) this._progress();
    return landed;
  }

  // ─── Проверки мира ──────────────────────────────────────────────────────────

  /**
   * Опасность у среза c: жидкости в самом срезе 3×3, в кольце вокруг него,
   * в срезе за ним и перед ним — всё, что окажется рядом с дырой от бура.
   */
  _danger(c, d) {
    const px = -d.z; // направление «вправо»
    const pz = d.x;
    // Коробка с запасом: удар по ногам гранью сверху задевает и соседние срезы.
    for (let f = -1; f <= 2; f++) {
      for (let l = -2; l <= 2; l++) {
        for (let h = -1; h <= 3; h++) {
          const p = c.offset(px * l + d.x * f, h, pz * l + d.z * f);
          if (!this._inWorld(p.y)) continue;
          const b = this._block(p);
          if (!b) return 'не прогружено';
          if (isLiquid(b)) return b.name.includes('lava') ? 'лава' : 'вода';
        }
      }
    }
    return null;
  }

  /** Есть ли пол под срезом c; drop — на сколько бот спрыгнет. */
  _floor(c) {
    for (let drop = 0; drop <= this.opt.maxDrop; drop++) {
      const p = c.offset(0, -1 - drop, 0);
      if (!this._inWorld(p.y)) return { blocked: 'край мира' };
      const b = this._block(p);
      if (!b) return { blocked: 'не прогружено' };
      if (isLiquid(b)) return { blocked: 'жидкость под ногами' };
      if (BAD_FLOOR.has(b.name)) return { blocked: `опасный пол (${b.name})` };
      if (isSolid(b)) {
        if (drop > 0) {
          // Место приземления: рядом с ногами и головой не должно быть жидкостей.
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              for (let h = 0; h <= 1; h++) {
                const n = this._block(p.offset(dx, 1 + h, dz));
                if (isLiquid(n)) return { blocked: `внизу ${n.name}` };
              }
            }
          }
        }
        return { drop };
      }
      if (!isPassable(b)) return { blocked: `неровный пол (${b.name})` };
    }
    return { blocked: `обрыв глубже ${this.opt.maxDrop} бл. (MINER_MAX_DROP)` };
  }

  _isOpen(c) {
    return isPassable(this._block(c)) && isPassable(this._block(c.offset(0, 1, 0)));
  }

  _inWorld(y) {
    const minY = (this.bot.game && this.bot.game.minY) || 0;
    const height = (this.bot.game && this.bot.game.height) || 256;
    return y >= minY && y < minY + height;
  }

  _feet() {
    return this.bot.entity.position.floored();
  }

  _block(p) {
    return this.bot.blockAt(p, false);
  }

  _failCount(p) {
    return this.fails.get(posKey(p)) || 0;
  }

  _addFail(p) {
    if (this.fails.size > 20000) this.fails.clear();
    const k = posKey(p);
    this.fails.set(k, (this.fails.get(k) || 0) + 1);
  }

  _progress() {
    this.lastProgressAt = Date.now();
  }

  // ─── Низкоуровневые действия (все с таймаутами) ─────────────────────────────

  async _dig(block, face) {
    const bot = this.bot;
    let time = 1000;
    try {
      time = bot.digTime(block);
    } catch (_) {}
    if (!Number.isFinite(time)) return false;
    try {
      await withTimeout(bot.dig(block, true, face), time + 2500, 'копание');
      this.stats.digs++;
      this.layerDigs++;
      return true;
    } catch (err) {
      this.log(`не сломал ${block.name}: ${err.message}`);
      try {
        bot.stopDigging();
      } catch (_) {}
      return false;
    }
  }

  _settle() {
    if (this.opt.settleMs != null) return sleep(this.opt.settleMs);
    const ping = (this.bot.player && this.bot.player.ping) || 50;
    return sleep(Math.min(Math.max(ping + 60, 80), 450));
  }

  /**
   * Идёт к центру блока c по прямой. Управляет кнопками сам, без pathfinder.
   * precise — подойти точно (подкрадываясь), нужно перед спуском в шахту 1×1.
   */
  _walkTo(c, { precise = false, drop = 0 } = {}) {
    const bot = this.bot;
    const tx = c.x + 0.5;
    const tz = c.z + 0.5;
    const tol = precise ? 0.15 : 0.3;
    const p0 = bot.entity.position;
    const timeoutMs = 1500 + Math.hypot(tx - p0.x, tz - p0.z) * (precise ? 1200 : 600) + drop * 150;

    return new Promise((resolve) => {
      const t0 = Date.now();
      let lastPos = p0.clone();
      let lastMoveAt = t0;
      let done = false;

      const finish = (ok) => {
        if (done) return;
        done = true;
        bot.removeListener('physicsTick', onTick);
        bot.removeListener('forcedMove', onForced);
        bot.setControlState('forward', false);
        bot.setControlState('sneak', false);
        bot.setControlState('sprint', false);
        resolve(ok);
      };
      const onForced = () => finish(false);
      const onTick = () => {
        if (!this.running) return finish(false);
        const p = bot.entity.position;
        const dx = tx - p.x;
        const dz = tz - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= tol && bot.entity.onGround) return finish(true);

        const now = Date.now();
        if (p.distanceTo(lastPos) > 0.05) {
          lastPos = p.clone();
          lastMoveAt = now;
        }
        if (now - lastMoveAt > 1200 || now - t0 > timeoutMs) return finish(false);

        const yaw = Math.atan2(-dx, -dz);
        if (Math.abs(yaw - bot.entity.yaw) > 0.01 || bot.entity.pitch !== 0) bot.look(yaw, 0, true);
        bot.setControlState('sneak', precise && dist < 0.8);
        bot.setControlState('forward', dist > tol);
      };
      bot.on('physicsTick', onTick);
      bot.on('forcedMove', onForced);
    });
  }

  _waitUntil(pred, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        let ok = false;
        try {
          ok = pred();
        } catch (_) {}
        if (ok || !this.running || Date.now() - t0 > ms) {
          clearInterval(iv);
          resolve(ok);
        }
      }, 25);
    });
  }

  async _unstick() {
    const bot = this.bot;
    bot.clearControlStates();
    try {
      bot.stopDigging();
    } catch (_) {}
    const me = bot.entity.position;
    const mob = bot.nearestEntity
      ? bot.nearestEntity((e) => HOSTILE.has(e.name) && e.position && e.position.distanceTo(me) < 3.5)
      : null;
    if (mob) {
      try {
        bot.attack(mob);
      } catch (_) {}
      await sleep(400);
      return;
    }
    bot.setControlState('jump', true);
    await sleep(300);
    bot.setControlState('jump', false);
    await sleep(200);
    await this._walkTo(this._feet(), {});
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

  async _maintain(id) {
    const bot = this.bot;
    const tool = this._findTool();
    if (!tool) {
      this.stop('в инвентаре нет кирки/бура');
      return false;
    }
    await this._equip(tool, 'hand');

    const left = durabilityLeft(bot.heldItem);
    if (left !== null && left <= this.opt.repairAt) {
      await this._repair(id);
      const now = durabilityLeft(bot.heldItem);
      if (now !== null && now <= this.opt.repairAt) {
        this.stop(`бур почти сломан (осталось ${now}), а починить нечем`);
        return false;
      }
    }
    if (bot.food <= this.opt.eatAt) {
      await this._eat();
      this._progress();
    }
    if (bot.inventory.emptySlotCount() <= this.opt.minFreeSlots && Date.now() - this.lastTossAt > 20000) {
      await this._tossJunk();
      this._progress();
    }
    await this._ensureHead();
    return this.alive(id);
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
        this._progress(); // долгая починка — не застревание
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
    const d = DIRS[this.dir];
    try {
      await bot.look(Math.atan2(d.x, d.z), 0, true); // спиной к забою — мусор летит назад
    } catch (_) {}
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

module.exports = { Miner, DIRS, DEFAULTS, DEFAULT_JUNK, dirFromYaw, durabilityLeft };
