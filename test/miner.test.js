/**
 * Тесты шахты без сервера и без сети.
 *
 * Стенд мира — в sim.js: FakeBot (упрощённое движение, быстро) и PhysicsBot
 * (настоящая физика mineflayer). Проверяется логика: змейка, слои, лава,
 * приват, сторож застревания, починка, еда, выброс мусора.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Miner, dirFromYaw } = require('../miner');
const { f3ToMineflayer, escapeMarkdown } = require('../utils');
const { FakeBot, PhysicsBot, quarryWorld, countStone } = require('./sim');

/** Запускает шахту и ждёт её остановки (или таймаута теста). */
function runMiner(bot, options = {}, { timeoutMs = 90000, stopAfterSteps = 0 } = {}) {
  const notes = [];
  const miner = new Miner(bot, { notify: (t) => notes.push(t), options: { settleMs: 5, ...options } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => miner.stop('таймаут теста'), timeoutMs);
    const poll = stopAfterSteps
      ? setInterval(() => {
        if (miner.stats.steps >= stopAfterSteps) miner.stop('достаточно');
      }, 20)
      : null;
    miner.onStop = (reason) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      bot.close();
      resolve({ reason, miner, notes });
    };
    miner.start();
  });
}

function openStart(world, x, y, z) {
  world.set(x, y, z, 'air');
  world.set(x, y + 1, z, 'air');
  return { x, y, z };
}

describe('шахта: проход карьера', { concurrency: true }, () => {
  test('карьер: спускается с поверхности, проходит слои змейкой и встаёт на бедроке', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, { x: 2, y: 13, z: 4 });
    const total = countStone(world);
    const { reason, miner } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена.*внизу bedrock/);
    assert.equal(bot.minY, 1, 'дошёл до дна');
    assert.ok(miner.stats.layers >= 3, `слоёв: ${miner.stats.layers}`);
    const mined = 1 - countStone(world) / total;
    assert.ok(mined > 0.75, `выкопано ${(mined * 100).toFixed(0)}%`);
  });

  test('то же на настоящей физике mineflayer', async () => {
    const world = quarryWorld();
    const bot = new PhysicsBot(world, { x: 2, y: 13, z: 4 });
    const total = countStone(world);
    const { reason } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена.*внизу bedrock/);
    assert.equal(bot.minY, 1);
    assert.ok(1 - countStone(world) / total > 0.75);
  });

  test('без бура на настоящей физике: туннель 1×2, центровка над шахтой 1×1', async () => {
    const world = quarryWorld();
    const bot = new PhysicsBot(world, { x: 2, y: 13, z: 4 }, { drill: false });
    const { reason } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена/);
    assert.equal(bot.minY, 1);
  });

  // Уступ над пустой шахтой: пол на 17 блоков ниже.
  const ledge = (x, y, z) => (x === 2 && y === 29 && z === 4 ? 'stone' : null);

  test('обрыв глубже maxDrop — останавливается с понятной причиной', async () => {
    const world = quarryWorld(ledge);
    const bot = new FakeBot(world, { x: 2, y: 30, z: 4 });
    const { reason } = await runMiner(bot);

    assert.match(reason, /обрыв глубже 3/);
    assert.equal(bot.minY, 30, 'не прыгал');
  });

  test('без урона от падения (maxDrop 64) — прыгает в шахту и копает до дна', async () => {
    const world = quarryWorld(ledge);
    const bot = new PhysicsBot(world, { x: 2, y: 30, z: 4 });
    const { reason, miner } = await runMiner(bot, { maxDrop: 64 });

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена/);
    assert.equal(bot.minY, 1);
    assert.ok(miner.stats.layers >= 3);
  });

  test('не прыгает туда, где внизу лава, — ищет другое место', async () => {
    const lavaPool = (x, y, z) => ledge(x, y, z) || (y === 13 && x === 4 && z === 4 ? 'lava' : null);
    const world = quarryWorld(lavaPool);
    const bot = new FakeBot(world, { x: 2, y: 30, z: 4 });
    const { reason } = await runMiner(bot, { maxDrop: 64 });

    assert.deepEqual(bot.violations, [], 'не приземлялся рядом с лавой');
    assert.match(reason, /шахта пройдена/);
    assert.equal(world.get(4, 13, 4), 'lava');
  });

  test('лава: не вскрывает её и не подходит вплотную', async () => {
    const lava = (x, y, z) => (x === 7 && y === 8 && z === 5 ? 'lava' : null);
    const world = quarryWorld(lava);
    const bot = new FakeBot(world, { x: 2, y: 13, z: 4 });
    const { reason } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена/);
    assert.equal(world.get(7, 8, 5), 'lava');
  });

  test('приват: блоки откатываются — бот разворачивается, а не долбит вечно', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4), { isProtected: (c) => c.x >= 7 });
    const { reason, miner } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена/);
    assert.ok(Math.floor(bot.entity.position.x) < 7, 'не зашёл в приват');
    assert.ok(bot.digCount < 1500, `ударов: ${bot.digCount}`);
    assert.ok(miner.stats.layers >= 2);
  });

  test('без бура: копает туннель 1×2 и тоже доходит до дна', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, { x: 2, y: 13, z: 4 }, { drill: false });
    const { reason } = await runMiner(bot);

    assert.deepEqual(bot.violations, []);
    assert.match(reason, /шахта пройдена/);
    assert.equal(bot.minY, 1);
  });

  test('сторож: бот не может сдвинуться — шахта останавливается с причиной', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4), { frozen: true });
    const t0 = Date.now();
    const { reason } = await runMiner(bot, { noProgressMs: 1500 });

    assert.match(reason, /нет продвижения/);
    assert.ok(Date.now() - t0 < 6000, `остановился за ${Date.now() - t0} мс`);
  });
});

describe('шахта: обслуживание', { concurrency: true }, () => {
  test('бур почти сломан — чинит пузырьками и копает дальше', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4));
    bot.heldItem.durabilityUsed = 1990; // осталось 41
    bot.inventory.slots[10] = { name: 'experience_bottle', slot: 10, count: 64 };
    const { reason, notes, miner } = await runMiner(bot, {}, { stopAfterSteps: 10 });

    assert.equal(reason, 'достаточно');
    assert.ok(notes.some((n) => n.includes('Починка закончена')), notes.join(' | '));
    assert.ok(bot.heldItem.maxDurability - bot.heldItem.durabilityUsed > 100);
    assert.equal(bot.heldItem.name, 'netherite_pickaxe');
    assert.ok(miner.stats.steps >= 10);
  });

  test('бур почти сломан и пузырьков нет — останавливается, а не ломает бур', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4));
    bot.heldItem.durabilityUsed = 1990;
    const { reason } = await runMiner(bot);

    assert.match(reason, /почти сломан/);
    assert.equal(bot.digCount, 0);
  });

  test('голоден — ест из инвентаря и возвращает бур в руку', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4));
    bot.food = 10;
    bot.inventory.slots[11] = { name: 'bread', slot: 11, count: 5 };
    const { reason } = await runMiner(bot, {}, { stopAfterSteps: 6 });

    assert.equal(reason, 'достаточно');
    assert.equal(bot.food, 20);
    assert.equal(bot.inventory.slots[11].count, 4);
    assert.equal(bot.heldItem.name, 'netherite_pickaxe');
  });

  test('инвентарь забит — выбрасывает только мусор', async () => {
    const world = quarryWorld();
    const bot = new FakeBot(world, openStart(world, 1, 10, 4));
    for (let s = 9; s < 44; s++) {
      if (s !== 36) bot.inventory.slots[s] = { name: 'cobblestone', slot: s, count: 64 };
    }
    bot.inventory.slots[12] = { name: 'diamond', slot: 12, count: 30 };
    bot.inventory.slots[13] = { name: 'tripwire_hook', slot: 13, count: 1 };
    const { reason } = await runMiner(bot, {}, { stopAfterSteps: 6 });

    assert.equal(reason, 'достаточно');
    assert.ok(bot.inventory.emptySlotCount() > 20);
    assert.equal(bot.inventory.slots[12].name, 'diamond');
    assert.equal(bot.inventory.slots[13].name, 'tripwire_hook');
  });
});

test('направление берётся из взгляда, F3 переводится в систему mineflayer', () => {
  assert.equal(dirFromYaw(0), 0); // север
  assert.equal(dirFromYaw(-Math.PI / 2), 1); // восток
  assert.equal(dirFromYaw(Math.PI), 2); // юг
  assert.equal(dirFromYaw(Math.PI / 2), 3); // запад

  // F3 «-90.0 / 30.0» — смотрим на восток и вниз
  const { yaw, pitch } = f3ToMineflayer(-90, 30);
  assert.equal(dirFromYaw(yaw), 1);
  assert.ok(pitch < 0);
  assert.equal(dirFromYaw(f3ToMineflayer(0, 0).yaw), 2); // F3 0 — юг
});

test('экранирование Markdown не оставляет лишних слэшей', () => {
  assert.equal(escapeMarkdown('Bot_1 (test).'), 'Bot\\_1 (test).');
});
