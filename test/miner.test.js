/**
 * Тесты шахты без сервера и без сети. Стенд мира — в sim.js (яма с висящими
 * блоками, стены и лобби под приватом, обновление шахты).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Miner } = require('../miner');
const { f3ToMineflayer, escapeMarkdown } = require('../utils');
const { FakeBot, mineWorld, countTargets, inPit } = require('./sim');

const CENTER = { x: 6, y: 51, z: 6 }; // дно ямы

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 30000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('не дождались условия');
    await sleep(20);
  }
}

/** Запускает шахту; возвращает управление, остановку тест делает сам. */
function startMiner(bot, options = {}) {
  const notes = [];
  const stops = [];
  const miner = new Miner(bot, {
    notify: (t) => notes.push(t),
    options: { settleMs: 5, emptyRescanMs: 20, pauseRetryMs: 50, ...options },
  });
  miner.onStop = (reason) => stops.push(reason);
  miner.start();
  const finish = async () => {
    miner.stop('тест');
    await waitFor(() => stops.length > 0, 5000);
    bot.close();
  };
  return { miner, notes, stops, finish };
}

/** Ни один блок вне ямы (стены, лобби) не сломан. */
function brokenOutside(world) {
  return [...world.diff.entries()]
    .filter(([k, v]) => v === 'air' && !inPit(...k.split(',').map(Number)))
    .map(([k]) => k);
}

describe('шахта-яма', { concurrency: true }, () => {
  test('выкапывает яму, ждёт обновления и копает снова — сама не выключается', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    const before = countTargets(world);
    const { miner, notes, stops, finish } = startMiner(bot);

    await waitFor(() => miner.state === 'ждёт обновления шахты');
    const firstPass = miner.stats.blocks;
    assert.ok(countTargets(world) < before * 0.1, `осталось ${countTargets(world)} из ${before}`);
    assert.ok(notes.some((n) => n.includes('Шахта пуста')));

    world.resetPit(); // прошло 5 минут
    await waitFor(() => miner.stats.blocks > firstPass + 20);

    assert.equal(stops.length, 0, 'шахта не выключалась сама');
    assert.deepEqual(brokenOutside(world), []);
    await finish();
  });

  test('приват: блок в стене пробует 2 раза, запоминает и больше не трогает', async () => {
    const extra = (x, y, z) => (x === 5 && y === 53 && z === -1 ? 'cobblestone' : null);
    const world = mineWorld({ extra });
    const bot = new FakeBot(world, CENTER);
    const { miner, finish } = startMiner(bot);

    await waitFor(() => miner.state === 'ждёт обновления шахты');
    assert.ok(miner.protectedBlocks.has('5,53,-1'));
    assert.equal(world.get(5, 53, -1), 'cobblestone');
    assert.deepEqual(brokenOutside(world), []);
    await finish();
  });

  test('без бура (обычная кирка) тоже выкапывает яму', async () => {
    const world = mineWorld({ seed: 7 });
    const bot = new FakeBot(world, CENTER, { drill: false });
    const before = countTargets(world);
    const { miner, finish } = startMiner(bot);

    await waitFor(() => miner.state === 'ждёт обновления шахты');
    assert.ok(countTargets(world) < before * 0.1, `осталось ${countTargets(world)} из ${before}`);
    await finish();
  });

  test('унесло из шахты (смерть, телепорт) — возвращается и копает дальше', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    const { miner, finish } = startMiner(bot, { center: CENTER });
    await waitFor(() => miner.stats.blocks > 5);

    bot.entity.position = new Vec3(30.5, 61, 30.5); // лобби, далеко от ямы
    world.set(30, 60, 30, 'stone');
    const was = miner.stats.blocks;
    await waitFor(() => miner.stats.blocks > was + 5);
    assert.ok(inPit(...bot.entity.position.floored().toArray()) || bot.entity.position.y < 62);
    await finish();
  });
});

describe('шахта: паузы и обслуживание', { concurrency: true }, () => {
  test('нет кирки — пауза с сообщением, дали кирку — продолжает сама', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    const pick = bot.inventory.slots[36];
    bot.inventory.slots[36] = null;
    bot.heldItem = null;
    const { miner, notes, stops, finish } = startMiner(bot);

    await waitFor(() => notes.some((n) => n.includes('на паузе')));
    assert.equal(miner.stats.blocks, 0);
    assert.equal(stops.length, 0);

    bot.inventory.slots[36] = pick;
    await waitFor(() => miner.stats.blocks > 5);
    assert.ok(notes.some((n) => n.includes('продолжает')));
    await finish();
  });

  test('бур почти сломан — чинит пузырьками и копает дальше', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    bot.heldItem.durabilityUsed = 1990; // осталось 41
    bot.inventory.slots[10] = { name: 'experience_bottle', slot: 10, count: 64 };
    const { miner, notes, finish } = startMiner(bot);

    await waitFor(() => miner.stats.blocks > 5);
    assert.ok(notes.some((n) => n.includes('Починка закончена')));
    assert.ok(bot.heldItem.maxDurability - bot.heldItem.durabilityUsed > 100);
    await finish();
  });

  test('бур почти сломан, пузырьков нет — пауза, бур не ломает', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    bot.heldItem.durabilityUsed = 1990;
    const { miner, notes, stops, finish } = startMiner(bot);

    await waitFor(() => notes.some((n) => n.includes('на паузе')));
    await sleep(200);
    assert.equal(bot.digCount, 0);
    assert.equal(stops.length, 0);
    assert.ok(miner.running);
    await finish();
  });

  test('голоден — ест и возвращает бур в руку', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    bot.food = 10;
    bot.inventory.slots[11] = { name: 'bread', slot: 11, count: 5 };
    const { miner, finish } = startMiner(bot);

    await waitFor(() => miner.stats.blocks > 3);
    assert.equal(bot.food, 20);
    assert.equal(bot.inventory.slots[11].count, 4);
    assert.equal(bot.heldItem.name, 'netherite_pickaxe');
    await finish();
  });

  test('инвентарь забит — выбрасывает только мусор', async () => {
    const world = mineWorld();
    const bot = new FakeBot(world, CENTER);
    for (let s = 9; s < 44; s++) {
      if (s !== 36) bot.inventory.slots[s] = { name: 'cobblestone', slot: s, count: 64 };
    }
    bot.inventory.slots[12] = { name: 'diamond', slot: 12, count: 30 };
    bot.inventory.slots[13] = { name: 'tripwire_hook', slot: 13, count: 1 };
    const { miner, finish } = startMiner(bot);

    await waitFor(() => miner.stats.blocks > 3);
    assert.ok(bot.inventory.emptySlotCount() > 20);
    assert.equal(bot.inventory.slots[12].name, 'diamond');
    assert.equal(bot.inventory.slots[13].name, 'tripwire_hook');
    await finish();
  });
});

test('F3 переводится в систему mineflayer', () => {
  const { yaw, pitch } = f3ToMineflayer(-90, 30); // восток, вниз
  assert.ok(Math.abs(-Math.sin(yaw) - 1) < 1e-9);
  assert.ok(pitch < 0);
  const south = f3ToMineflayer(0, 0).yaw;
  assert.ok(Math.abs(-Math.cos(south) - 1) < 1e-9);
});

test('экранирование Markdown не оставляет лишних слэшей', () => {
  assert.equal(escapeMarkdown('Bot_1 (test).'), 'Bot\\_1 (test).');
});
