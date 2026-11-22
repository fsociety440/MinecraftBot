/**
 * Упрощённый симулятор мира для тестов шахты: блоки в Map, бур ломает 3×3
 * в плоскости грани удара, гравитация — по блоку за тик, ходьба — 0.25 блока
 * за тик с проверкой столкновений. Это не физика Minecraft, а стенд для логики.
 */
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');

const UNBREAKABLE = new Set(['bedrock']);
const EMPTY = new Set(['air', 'water', 'lava']);
const passable = (name) => name === 'air';
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

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
}

class FakeBot extends EventEmitter {
  constructor(world, start, opts = {}) {
    super();
    this.world = world;
    this.drill = opts.drill !== false;
    this.isProtected = opts.isProtected || (() => false);
    this.frozen = !!opts.frozen;
    this.game = { minY: 0, height: 256 };
    this.player = { ping: 0 };
    this.food = 20;
    this.registry = { foodsByName: { bread: { foodPoints: 5, saturation: 6 } } };
    this.entity = {
      position: new Vec3(start.x + 0.5, start.y, start.z + 0.5),
      yaw: opts.yaw ?? -Math.PI / 2, // восток
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
    this.violations = [];
    this.minY = start.y;
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
      type: name === 'air' ? 0 : 1,
      position: new Vec3(x, y, z),
      boundingBox: EMPTY.has(name) ? 'empty' : 'block',
      hardness: unbreakable ? null : 1.5,
      diggable: !unbreakable,
    };
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
    if (reach > 5) this.violations.push(`дальность удара ${reach.toFixed(2)}`);

    const cells = [];
    if (this.drill) {
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          if (face.y) cells.push(p.offset(a, 0, b));
          else if (face.x) cells.push(p.offset(0, a, b));
          else cells.push(p.offset(a, b, 0));
        }
      }
    } else {
      cells.push(p);
    }
    const restore = [];
    for (const c of cells) {
      const name = this.world.get(c.x, c.y, c.z);
      if (UNBREAKABLE.has(name) || EMPTY.has(name)) continue;
      this.world.set(c.x, c.y, c.z, 'air');
      if (this.isProtected(c)) restore.push([c, name]);
      else this._checkLava(c, 'лава открыта ударом');
    }
    // Приват: сервер откатывает блоки через «пинг».
    if (restore.length) {
      setTimeout(() => {
        for (const [c, name] of restore) this.world.set(c.x, c.y, c.z, name);
      }, 2);
    }
  }

  _checkLava(c, label) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (this.world.get(c.x + dx, c.y + dy, c.z + dz) === 'lava') {
        this.violations.push(`${label} у ${c.x},${c.y},${c.z}`);
        return;
      }
    }
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

  tick() {
    const e = this.entity;
    const p = e.position;
    const fx = Math.floor(p.x);
    const fz = Math.floor(p.z);
    const below = this.world.get(fx, Math.floor(p.y) - 1, fz);
    if (!this.frozen && passable(below) && p.y > 1) {
      p.y = Math.floor(p.y) - 1;
      e.onGround = false;
    } else {
      e.onGround = true;
    }

    if (!this.frozen && this.controlState.forward) {
      const speed = this.controlState.sneak ? 0.05 : 0.25;
      const nx = p.x - Math.sin(e.yaw) * speed;
      const nz = p.z - Math.cos(e.yaw) * speed;
      const by = Math.floor(p.y);
      const bx = Math.floor(nx);
      const bz = Math.floor(nz);
      if (passable(this.world.get(bx, by, bz)) && passable(this.world.get(bx, by + 1, bz))) {
        p.x = nx;
        p.z = nz;
      }
    }

    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    if (!passable(this.world.get(cx, cy, cz)) || !passable(this.world.get(cx, cy + 1, cz))) {
      this.violations.push(`бот внутри блока ${cx},${cy},${cz}`);
    }
    this._checkLava(new Vec3(cx, cy, cz), 'бот рядом с лавой');
    this._checkLava(new Vec3(cx, cy + 1, cz), 'бот рядом с лавой');
    this.minY = Math.min(this.minY, cy);
    this.emit('physicsTick');
  }
}

/**
 * Тот же стенд, но движение и гравитация — настоящая физика mineflayer
 * (prismarine-physics 1.16.5): инерция, трение, хитбокс 0.6×1.8, Shift не даёт
 * упасть с края. Блоки — настоящие prismarine-block. Тик идёт быстрее реального.
 */
class PhysicsBot extends FakeBot {
  constructor(world, start, opts = {}) {
    super(world, start, opts);
    const version = '1.16.5';
    const { Physics, PlayerState } = require('prismarine-physics');
    this.version = version;
    this.mcData = require('minecraft-data')(version);
    this.Block = require('prismarine-block')(version);
    this.PlayerState = PlayerState;
    this.entity.velocity = new Vec3(0, 0, 0);
    this.entity.effects = {};
    this.jumpTicks = 0;
    this.jumpQueued = false;
    this.fireworkRocketDuration = 0;
    this.physicsWorld = { getBlock: (p) => this.blockAt(p) };
    this.physics = Physics(this.mcData, this.physicsWorld);
  }

  blockAt(p) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (y < 0 || y >= 256) return null;
    const block = this.Block.fromStateId(this.mcData.blocksByName[this.world.get(x, y, z)].defaultState, 0);
    block.position = new Vec3(x, y, z);
    return block;
  }

  tick() {
    if (!this.frozen && this.physics) {
      const cs = this.controlState;
      const control = {
        forward: !!cs.forward, back: !!cs.back, left: !!cs.left, right: !!cs.right,
        jump: !!cs.jump, sprint: !!cs.sprint, sneak: !!cs.sneak,
      };
      const state = new this.PlayerState(this, control);
      this.physics.simulatePlayer(state, this.physicsWorld);
      state.apply(this);
    }
    const p = this.entity.position.floored();
    this._checkLava(p, 'бот рядом с лавой');
    this._checkLava(p.offset(0, 1, 0), 'бот рядом с лавой');
    this.minY = Math.min(this.minY, p.y);
    this.emit('physicsTick');
  }
}

/** Каменная коробка x 0..11, z 0..8, y 1..12 в бедроковых стенах, дно — бедрок. */
function quarryWorld(extra = () => null) {
  return new FakeWorld((x, y, z) => {
    const special = extra(x, y, z);
    if (special) return special;
    if (y === 0) return 'bedrock';
    if (x < 0 || x > 11 || z < 0 || z > 8) return y <= 14 ? 'bedrock' : 'air';
    return y <= 12 ? 'stone' : 'air';
  });
}

function countStone(world) {
  let n = 0;
  for (let x = 0; x <= 11; x++) {
    for (let z = 0; z <= 8; z++) {
      for (let y = 1; y <= 12; y++) if (world.get(x, y, z) === 'stone') n++;
    }
  }
  return n;
}

module.exports = { FakeWorld, FakeBot, PhysicsBot, quarryWorld, countStone };
