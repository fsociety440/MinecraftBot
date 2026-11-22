/**
 * Стенд для тестов шахты: мир в Map, без сервера и сети.
 *
 * Шахта как на скриншоте HolyWorld: яма 13×13 (x,z 0..12), пол y=50, стены и
 * лобби вокруг — под приватом; внутри (y 52..58) висят блоки камня и руды.
 * Бур ломает 3×3 в плоскости грани удара; приват откатывает блоки через «пинг».
 * pathfinder подменён: goto ставит бота в ближайшую точку, где можно стоять.
 */
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');

const NAMES = [
  'air', 'bedrock', 'stone', 'cobblestone', 'iron_ore', 'redstone_ore', 'lapis_ore',
  'dark_oak_planks', 'ladder', 'lava', 'water',
];
const BLOCKS_BY_NAME = Object.fromEntries(NAMES.map((name, id) => [name, { id, name }]));
const UNBREAKABLE = new Set(['bedrock']);
const EMPTY = new Set(['air', 'water', 'lava', 'ladder']);
const passable = (name) => name === 'air' || name === 'ladder';

const PIT = { min: 0, max: 12, floor: 50, top: 60 };
const inPit = (x, y, z) => x >= PIT.min && x <= PIT.max && z >= PIT.min && z <= PIT.max && y > PIT.floor && y < PIT.top;

function hash(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 100;
}

class FakeWorld {
  constructor(gen) {
    this.gen = gen;
    this.diff = new Map();
  }

  get(x, y, z) {
    const k = `${x},${y},${z}`;
    return this.diff.has(k) ? this.diff.get(k) : this.gen(x, y, z);
  }

  set(x, y, z, name) {
    this.diff.set(`${x},${y},${z}`, name);
  }

  /** Обновление шахты: всё в яме возвращается как было. */
  resetPit() {
    for (const k of [...this.diff.keys()]) {
      const [x, y, z] = k.split(',').map(Number);
      if (inPit(x, y, z)) this.diff.delete(k);
    }
  }
}

/** Яма с висящими блоками; extra(x,y,z) может подменить любой блок. */
function mineWorld({ seed = 1, extra = () => null } = {}) {
  return new FakeWorld((x, y, z) => {
    const special = extra(x, y, z);
    if (special) return special;
    if (y < PIT.floor) return 'bedrock';
    const ring = x >= PIT.min - 1 && x <= PIT.max + 1 && z >= PIT.min - 1 && z <= PIT.max + 1;
    if (inPit(x, y, z)) {
      if (y < 52 || y > 58) return 'air';
      const h = hash(x, y, z, seed);
      if (h < 12) return 'stone';
      if (h < 18) return 'cobblestone';
      if (h < 21) return 'iron_ore';
      if (h < 23) return 'redstone_ore';
      if (h < 25) return 'lapis_ore';
      return 'air';
    }
    if (y === PIT.floor && ring) return 'dark_oak_planks';
    if (ring && y < PIT.top) return x === PIT.min - 1 && z === 6 ? 'ladder' : 'dark_oak_planks';
    if (y === PIT.top || y === PIT.floor) return 'stone'; // пол лобби — тоже камень, но приват
    return 'air';
  });
}

function countTargets(world) {
  let n = 0;
  for (let x = PIT.min; x <= PIT.max; x++) {
    for (let z = PIT.min; z <= PIT.max; z++) {
      for (let y = PIT.floor + 1; y < PIT.top; y++) {
        const name = world.get(x, y, z);
        if (name !== 'air' && name !== 'ladder') n++;
      }
    }
  }
  return n;
}

class FakeBot extends EventEmitter {
  constructor(world, start, opts = {}) {
    super();
    this.world = world;
    this.drill = opts.drill !== false;
    this.isProtected = opts.isProtected || ((c) => !inPit(c.x, c.y, c.z));
    this.game = { minY: 0, height: 256 };
    this.player = { ping: 0 };
    this.health = 20;
    this.isAlive = true;
    this.food = 20;
    this.registry = { blocksByName: BLOCKS_BY_NAME, foodsByName: { bread: { foodPoints: 5, saturation: 6 } } };
    this.entity = {
      position: new Vec3(start.x + 0.5, start.y, start.z + 0.5),
      yaw: 0,
      pitch: 0,
      onGround: true,
    };
    this.controlState = {};
    const slots = new Array(46).fill(null);
    const pick = { name: 'netherite_pickaxe', customName: 'Бур', slot: 36, maxDurability: 2031, durabilityUsed: 0 };
    slots[36] = pick;
    this.inventory = {
      slots,
      items: () => slots.slice(9, 45).filter(Boolean),
      emptySlotCount: () => slots.slice(9, 45).filter((s) => !s).length,
    };
    this.heldItem = pick;
    this.digCount = 0;
    this.gotoCount = 0;
    this.brokenOutside = [];
    this.pathfinder = {
      goto: (goal) => this._goto(goal),
      setGoal: () => {},
      setMovements: () => {},
    };
    this.timer = setInterval(() => this.tick(), 1);
  }

  close() {
    clearInterval(this.timer);
  }

  blockAt(p) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (y < 0 || y >= 256) return null;
    const name = this.world.get(x, y, z);
    const unbreakable = UNBREAKABLE.has(name);
    return {
      name,
      type: BLOCKS_BY_NAME[name].id,
      position: new Vec3(x, y, z),
      boundingBox: EMPTY.has(name) ? 'empty' : 'block',
      hardness: unbreakable ? null : 1.5,
      diggable: !unbreakable,
    };
  }

  findBlocks({ point, matching, maxDistance, count }) {
    const ids = new Set(matching);
    const out = [];
    const r = Math.ceil(maxDistance);
    for (let x = point.x - r; x <= point.x + r; x++) {
      for (let y = point.y - r; y <= point.y + r; y++) {
        for (let z = point.z - r; z <= point.z + r; z++) {
          if (y < 0 || y >= 256) continue;
          if (ids.has(BLOCKS_BY_NAME[this.world.get(x, y, z)].id)) out.push(new Vec3(x, y, z));
        }
      }
    }
    out.sort((a, b) => a.distanceTo(point) - b.distanceTo(point));
    return out.slice(0, count);
  }

  digTime(block) {
    return UNBREAKABLE.has(block.name) ? Infinity : 0;
  }

  async dig(block, forceLook, face) {
    await new Promise((r) => setImmediate(r));
    this.digCount++;
    const p = block.position;
    const eye = this.entity.position.offset(0, 1.62, 0);
    const reach = eye.distanceTo(p.offset(0.5, 0.5, 0.5));
    if (reach > 5.5) throw new Error(`дальность удара ${reach.toFixed(2)}`);

    const cells = [p];
    if (this.drill) {
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          if (!a && !b) continue;
          if (typeof face === 'object' && face.x) cells.push(p.offset(0, a, b));
          else if (typeof face === 'object' && face.z) cells.push(p.offset(a, b, 0));
          else cells.push(p.offset(a, 0, b));
        }
      }
    }
    const restore = [];
    for (const c of cells) {
      const name = this.world.get(c.x, c.y, c.z);
      if (UNBREAKABLE.has(name) || EMPTY.has(name)) continue;
      this.world.set(c.x, c.y, c.z, 'air');
      if (this.isProtected(c)) restore.push([c, name]);
    }
    if (restore.length) {
      setTimeout(() => {
        for (const [c, name] of restore) this.world.set(c.x, c.y, c.z, name);
      }, 2);
    }
  }

  /** Упрощённый pathfinder: ближайшая точка у цели, где можно стоять. */
  _goto(goal) {
    this.gotoCount++;
    let best = null;
    let bestD = Infinity;
    for (let x = goal.x - 4; x <= goal.x + 4; x++) {
      for (let y = goal.y - 4; y <= goal.y + 4; y++) {
        for (let z = goal.z - 4; z <= goal.z + 4; z++) {
          const d = (x - goal.x) ** 2 + (y - goal.y) ** 2 + (z - goal.z) ** 2;
          if (d > goal.rangeSq || d >= bestD) continue;
          if (!passable(this.world.get(x, y, z)) || !passable(this.world.get(x, y + 1, z))) continue;
          if (EMPTY.has(this.world.get(x, y - 1, z))) continue;
          best = new Vec3(x + 0.5, y, z + 0.5);
          bestD = d;
        }
      }
    }
    if (!best) return Promise.reject(new Error('No path to the goal!'));
    return new Promise((resolve) => setTimeout(() => {
      this.entity.position = best;
      resolve();
    }, 2));
  }

  stopDigging() {}

  look(yaw, pitch) {
    this.entity.yaw = yaw;
    this.entity.pitch = pitch;
    return Promise.resolve();
  }

  setControlState(k, v) {
    this.controlState[k] = v;
  }

  clearControlStates() {
    this.controlState = {};
  }

  equip(item, dest) {
    if (dest === 'hand') {
      this.heldItem = item;
    } else {
      // Левая рука — обмен со слотом, как в игре.
      const slots = this.inventory.slots;
      const prev = slots[45];
      slots[item.slot] = prev;
      if (prev) prev.slot = item.slot;
      slots[45] = item;
      item.slot = 45;
    }
    return Promise.resolve();
  }

  unequip() {
    this.inventory.slots[45] = null;
    return Promise.resolve();
  }

  tossStack(item) {
    this.inventory.slots[item.slot] = null;
    return Promise.resolve();
  }

  consume() {
    const food = this.heldItem;
    if (food && this.registry.foodsByName[food.name]) {
      this.food = 20;
      if (--food.count === 0) this.inventory.slots[food.slot] = null;
    }
    return Promise.resolve();
  }

  /** Бросок пузырька из левой руки: «Починка» сразу возвращает 14 прочности. */
  activateItem(offHand) {
    const off = this.inventory.slots[45];
    if (!offHand || !off || off.name !== 'experience_bottle') return;
    if (--off.count === 0) this.inventory.slots[45] = null;
    if (this.heldItem && this.heldItem.durabilityUsed !== undefined) {
      this.heldItem.durabilityUsed = Math.max(0, this.heldItem.durabilityUsed - 14);
    }
  }

  deactivateItem() {}

  nearestEntity() {
    return null;
  }

  /** Гравитация: падает по блоку за тик, пока под ногами пусто (лестница держит). */
  tick() {
    const p = this.entity.position;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const here = this.world.get(x, y, z);
    const below = this.world.get(x, y - 1, z);
    if (here !== 'ladder' && EMPTY.has(below) && y > 1) {
      this.entity.position = new Vec3(p.x, y - 1, p.z);
      this.entity.onGround = false;
    } else {
      this.entity.onGround = true;
    }
    this.emit('physicsTick');
  }
}

module.exports = { FakeWorld, FakeBot, mineWorld, countTargets, inPit, PIT };
