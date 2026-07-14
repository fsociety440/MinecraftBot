/**
 * captcha.js — Модуль обработки карточной капчи
 *
 * Принцип работы:
 *  1. Ищем ближайшие Item Frame-сущности перед ботом.
 *  2. Определяем, какая карта (map item) вставлена в каждую рамку.
 *  3. Получаем пиксельные данные каждой карты через пакет map_data.
 *  4. Склеиваем N карт в сетку (CAPTCHA_COLS × CAPTCHA_ROWS) через sharp.
 *  5. Отправляем результат в Telegram.
 *
 * Важно: mineflayer хранит данные карт в bot.world.maps (Map<mapId, mapData>).
 * Нам нужно дождаться, пока придут пакеты map_data для всех нужных карт.
 */

const sharp  = require('sharp');
const cfg    = require('./config');
const util   = require('util');

// Глобальный кэш карт для текущей сессии бота
const mapCache = new Map();

const MAP_SIZE = cfg.CAPTCHA_MAP_SIZE; // 128 px

/**
 * Строит палитру цветов Minecraft-карты (256 цветов) в формате RGBA.
 * Индексы 0-3 — прозрачные, остальные вычисляются из baseColors.
 *
 * Источник: https://minecraft.wiki/w/Map_item_format#Color_table
 */
const BASE_COLORS = [
  [0,0,0],       // 0 transparent
  [127,178,56],  // 1 GRASS
  [247,233,163], // 2 SAND
  [199,199,199], // 3 WOOL_WHITE
  [255,0,0],     // 4 FIRE / TNT
  [160,160,255], // 5 ICE
  [167,167,167], // 6 METAL
  [0,124,0],     // 7 PLANT
  [255,255,255], // 8 SNOW
  [164,168,184], // 9 CLAY
  [151,109,77],  // 10 DIRT
  [112,112,112], // 11 STONE
  [64,64,255],   // 12 WATER
  [143,119,72],  // 13 WOOD
  [255,252,245], // 14 QUARTZ
  [216,127,51],  // 15 COLOR_ORANGE
  [178,76,216],  // 16 COLOR_MAGENTA
  [102,153,216], // 17 COLOR_LIGHT_BLUE
  [229,229,51],  // 18 COLOR_YELLOW
  [127,204,25],  // 19 COLOR_LIGHT_GREEN
  [242,127,165], // 20 COLOR_PINK
  [76,76,76],    // 21 COLOR_GRAY
  [153,153,153], // 22 COLOR_LIGHT_GRAY
  [76,127,153],  // 23 COLOR_CYAN
  [127,63,178],  // 24 COLOR_PURPLE
  [51,76,178],   // 25 COLOR_BLUE
  [102,76,51],   // 26 COLOR_BROWN
  [102,127,51],  // 27 COLOR_GREEN
  [153,51,51],   // 28 COLOR_RED
  [25,25,25],    // 29 COLOR_BLACK
  [250,238,77],  // 30 GOLD
  [92,219,213],  // 31 DIAMOND
  [74,128,255],  // 32 LAPIS
  [0,217,58],    // 33 EMERALD
  [129,86,49],   // 34 PODZOL / SPRUCE
  [112,2,0],     // 35 NETHER
  [209,177,161], // 36 TERRACOTTA_WHITE
  [159,82,36],   // 37 TERRACOTTA_ORANGE
  [149,87,108],  // 38 TERRACOTTA_MAGENTA
  [112,108,138], // 39 TERRACOTTA_LIGHT_BLUE
  [186,133,36],  // 40 TERRACOTTA_YELLOW
  [103,117,53],  // 41 TERRACOTTA_LIGHT_GREEN
  [160,77,78],   // 42 TERRACOTTA_PINK
  [57,41,35],    // 43 TERRACOTTA_GRAY
  [135,107,98],  // 44 TERRACOTTA_LIGHT_GRAY
  [87,92,92],    // 45 TERRACOTTA_CYAN
  [122,73,88],   // 46 TERRACOTTA_PURPLE
  [76,62,92],    // 47 TERRACOTTA_BLUE
  [76,50,35],    // 48 TERRACOTTA_BROWN
  [76,82,42],    // 49 TERRACOTTA_GREEN
  [142,60,46],   // 50 TERRACOTTA_RED
  [37,22,16],    // 51 TERRACOTTA_BLACK
  [189,48,49],   // 52 CRIMSON_NYLIUM
  [148,63,97],   // 53 CRIMSON_STEM
  [92,25,29],    // 54 CRIMSON_HYPHAE
  [22,126,134],  // 55 WARPED_NYLIUM
  [58,142,140],  // 56 WARPED_STEM
  [86,44,62],    // 57 WARPED_HYPHAE
  [20,180,133],  // 58 WARPED_WART_BLOCK
];

// Множители яркости для 4 оттенков каждого базового цвета
const SHADE_MULT = [180, 220, 255, 135];

/**
 * Строит полную таблицу цветов (1024 записи) в виде Buffer [R,G,B,A, ...]
 */
function buildColorTable() {
  const buf = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) {
    if (i < 4) {
      // 0-3: прозрачно
      buf.writeUInt32BE(0, i * 4);
      continue;
    }
    const baseIdx = Math.floor(i / 4);
    const shade   = i % 4;
    const base    = BASE_COLORS[baseIdx] || [0, 0, 0];
    const m       = SHADE_MULT[shade] / 255;
    const r = Math.round(base[0] * m);
    const g = Math.round(base[1] * m);
    const b = Math.round(base[2] * m);
    buf[i * 4]     = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255; // непрозрачный
  }
  return buf;
}

const COLOR_TABLE = buildColorTable();

/**
 * Конвертирует сырые данные карты (128×128 индексов цветов) в RGBA Buffer.
 * @param {Buffer|Uint8Array} colors — массив 16384 байт (индексы 0-255)
 * @returns {Buffer} RGBA, 128×128×4 байт
 */
function mapColorsToRGBA(colors) {
  const rgba = Buffer.alloc(MAP_SIZE * MAP_SIZE * 4);
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
    const ci = colors[i] & 0xff;
    rgba[i * 4]     = COLOR_TABLE[ci * 4];
    rgba[i * 4 + 1] = COLOR_TABLE[ci * 4 + 1];
    rgba[i * 4 + 2] = COLOR_TABLE[ci * 4 + 2];
    rgba[i * 4 + 3] = COLOR_TABLE[ci * 4 + 3];
  }
  return rgba;
}

/**
 * Склеивает массив буферов RGBA (128×128) в сетку COLS×ROWS через sharp.
 * @param {Buffer[]} rgbaList
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<Buffer>} PNG-буфер итогового изображения
 */
async function compositeGrid(rgbaList, cols, rows) {
  const total = cols * rows;
  // Дополняем пустыми, если не хватает
  while (rgbaList.length < total) {
    rgbaList.push(Buffer.alloc(MAP_SIZE * MAP_SIZE * 4, 0));
  }

  const width  = cols * MAP_SIZE;
  const height = rows * MAP_SIZE;

  // Создаём пустой холст
  const base = sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  });

  // Подготавливаем композитный список
  const composites = await Promise.all(
    rgbaList.slice(0, total).map(async (rgba, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const pngBuf = await sharp(rgba, {
        raw: { width: MAP_SIZE, height: MAP_SIZE, channels: 4 },
      }).png().toBuffer();
      return {
        input: pngBuf,
        left: col * MAP_SIZE,
        top:  row * MAP_SIZE,
      };
    })
  );

  return base.composite(composites).png().toBuffer();
}

/**
 * Ожидает, пока данные карты с нужным id появятся в bot.game.maps
 * или придут через packet-listener. Таймаут 10 секунд.
 * @param {import('mineflayer').Bot} bot
 * @param {number} mapId
 * @returns {Promise<Uint8Array|null>}
 */
function waitForMapData(bot, mapId) {
  return new Promise((resolve) => {
    // 2. Ищем данные этой карты в кэше
    const mapData = bot._mapCache.get(mapId);
    if (mapData && mapData.length === MAP_SIZE * MAP_SIZE) {
        resolve(mapData);
        return;
    }

    const timeout = setTimeout(() => {
      console.warn(`[Captcha] Таймаут ожидания данных карты ${mapId}`);
      resolve(null);
    }, 10_000);

    const onMapData = (mapIdReceived) => {
      if (mapIdReceived === mapId) {
        const data = bot._mapCache.get(mapId);
        if (data && data.length === MAP_SIZE * MAP_SIZE) {
          clearTimeout(timeout);
          bot.removeListener('map_updated', onMapData);
          resolve(data);
        }
      }
    };

    bot.on('map_updated', onMapData);
  });
}

/**
 * Инициализирует слушатель пакетов `map` для конкретного бота.
 * @param {import('mineflayer').Bot} bot
 */
function initMapListener(bot) {
  // У каждого бота свой кэш карт
  bot._mapCache = bot._mapCache || new Map();

  bot._client.on('map', (packet) => {
    if (packet.itemDamage !== undefined && packet.data && packet.data.length === MAP_SIZE * MAP_SIZE) {
      console.log(`[MC DEBUG MAP] id=${packet.itemDamage} dataLen=${packet.data.length}`);
      
      bot._mapCache.set(packet.itemDamage, packet.data);
      bot.emit('map_updated', packet.itemDamage);
    }
  });
}

/**
 * Собирает картинку капчи из рамок и отправляет в TG.
 * @param {import('mineflayer').Bot} bot
 * @param {object} mcBotInstance (экземпляр класса MinecraftBot)
 */
async function captureAndSendCaptcha(bot, mcBotInstance) {
  console.log('[Captcha] Начинаю сбор капчи...');

  // ── 1. Ищем Item Frame сущности (≤10 блоков от бота) ─────────────────────
  const frames = Object.values(bot.entities).filter(e => {
    if (!e || !e.position) return false;
    const typeName = (e.entityType && e.name) ? e.name : (e.type || '');
    const isFrame  = typeName === 'item_frame' || typeName === 'glow_item_frame';
    if (!isFrame) return false;
    return e.position.distanceTo(bot.entity.position) <= 10;
  });

  if (!frames.length) {
    mcBotInstance.tg.sendMessage('⚠️ Item Frame-сущности не найдены рядом с ботом.');
    return;
  }

  console.log(`[Captcha] Найдено рамок: ${frames.length}`);

  // ── 2. Сортируем рамки геометрически (как видит игрок) ────────
  // Вычисляем центр всех рамок, чтобы понять, в какую сторону смотрит бот
  let cx = 0, cz = 0;
  for (const f of frames) { cx += f.position.x; cz += f.position.z; }
  cx /= frames.length; cz /= frames.length;

  // Вектор от бота к центру стены
  const dx = cx - bot.entity.position.x;
  const dz = cz - bot.entity.position.z;
  
  // Вектор "влево" относительно взгляда бота (поворот на 90 градусов против часовой стрелки в плоскости XZ)
  const leftX = dz;
  const leftZ = -dx;

  const sorted = frames.slice().sort((a, b) => {
    // Сначала сверху вниз (по Y)
    const dy = b.position.y - a.position.y;
    if (Math.abs(dy) > 0.5) return dy;
    
    // Затем слева направо (проекция на вектор "влево")
    // Чем больше проекция, тем левее находится рамка, поэтому сортируем по убыванию проекции
    const projA = a.position.x * leftX + a.position.z * leftZ;
    const projB = b.position.x * leftX + b.position.z * leftZ;
    return projB - projA;
  });

  // ── 3. Извлекаем map ID из каждой рамки ───────────────────────────────────
  // В протоколе 1.16 item frame хранит item в metadata слота 8
  const mapIds = [];
  for (const frame of sorted.slice(0, cfg.CAPTCHA_COLS * cfg.CAPTCHA_ROWS)) {
    try {
      // frame.metadata[8] — HandItem (слот с предметом внутри рамки)
      const meta = frame.metadata;
      let mapId  = null;

      // Попытка 1: через metadata (в 1.14+ предмет хранится в индексе 7)
      if (meta && meta[7]) {
        // У слота (Item) есть blockId (itemId), itemCount, nbtData
        const item = meta[7];
        if (item.nbtData && item.nbtData.value && item.nbtData.value.map) {
          mapId = item.nbtData.value.map.value;
        }
      }

      // Попытка 2: через bot.entities напрямую (некоторые сборки mineflayer)
      if (mapId === null && frame.item) {
        mapId = frame.item.nbt?.value?.map?.value;
      }

      // Дебаг: если всё ещё null, выведем структуру, чтобы понять, где лежит mapId
      if (mapId === null) {
         console.log(`[Captcha DEBUG] Frame meta: ${util.inspect(meta, {depth: 5})}`);
      }

      mapIds.push(mapId);
      console.log(`[Captcha] Frame @ ${JSON.stringify(frame.position)} → mapId=${mapId}`);
    } catch (e) {
      console.warn('[Captcha] Ошибка чтения metadata рамки:', e.message);
      mapIds.push(null);
    }
  }

  if (mapIds.every(id => id === null)) {
    mcBotInstance.tg.sendMessage(
      '⚠️ Не удалось прочитать ID карт из рамок.\n' +
      'Убедитесь, что бот стоит близко к рамкам и они содержат Map items.'
    );
    return;
  }

  // ── 4. Получаем пиксельные данные каждой карты ────────────────────────────
  mcBotInstance.tg.sendMessage(`🗺 Получаю данные ${mapIds.length} карт...`);

  const rgbaList = [];
  for (const mapId of mapIds) {
    if (mapId === null) {
      rgbaList.push(Buffer.alloc(MAP_SIZE * MAP_SIZE * 4, 128)); // серый заполнитель
      continue;
    }
    const colors = await waitForMapData(bot, mapId);
    if (colors) {
      rgbaList.push(mapColorsToRGBA(colors));
    } else {
      rgbaList.push(Buffer.alloc(MAP_SIZE * MAP_SIZE * 4, 64)); // тёмный заполнитель
    }
  }

  // ── 5. Склеиваем и отправляем ─────────────────────────────────────────────
  try {
    const png = await compositeGrid(rgbaList, cfg.CAPTCHA_COLS, cfg.CAPTCHA_ROWS);
    mcBotInstance.tg.sendCaptchaImage(mcBotInstance, png);
    console.log('[Captcha] Капча успешно собрана и отправлена в Telegram.');
  } catch (err) {
    console.error('[Captcha] Ошибка сборки изображения:', err);
    mcBotInstance.tg.sendMessage(`❌ Ошибка при сборке изображения капчи: ${err.message}`);
  }
  return true;
}

module.exports = {
  initMapListener,
  captureAndSendCaptcha,
};
