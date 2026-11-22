/**
 * config.js — загрузка конфигурации из .env
 * Все настройки бота хранятся здесь.
 */

require('dotenv').config();

const int = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

module.exports = {
  // ─── Minecraft ────────────────────────────────────────────────────────────
  // Ник, IP и порт каждого бота задаются в Telegram и хранятся в bots.json.
  MC_VERSION: process.env.MC_VERSION || '1.16.5',

  // ─── Telegram ─────────────────────────────────────────────────────────────
  TG_TOKEN: process.env.TG_TOKEN || '',           // Токен бота от @BotFather
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',       // Ваш личный chat_id — только он может управлять

  // ─── Фарм ────────────────────────────────────────────────────────────────
  FARM_INTERVAL_MS: int('FARM_INTERVAL_MS', 1500), // мс между ударами

  // ─── Переподключение ──────────────────────────────────────────────────────
  RECONNECT_DELAY_MS: int('RECONNECT_DELAY_MS', 30000),

  // ─── Шахта (подробности и остальные параметры — DEFAULTS в miner.js) ─────
  MINER: {
    radius: int('MINER_RADIUS', undefined),             // радиус шахты от места включения (10)
    maxDrop: int('MINER_MAX_DROP', undefined),          // с какой высоты можно падать (64)
    eatAt: int('MINER_EAT_AT', undefined),              // есть при сытости ≤ (14)
    repairAt: int('MINER_REPAIR_AT', undefined),        // чинить бур при прочности ≤ (100)
    targets: process.env.MINER_BLOCKS ? process.env.MINER_BLOCKS.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
  },

  // ─── Капча ────────────────────────────────────────────────────────────────
  CAPTCHA_COLS: 4,   // колонок в сетке карт
  CAPTCHA_ROWS: 3,   // строк в сетке карт
  CAPTCHA_MAP_SIZE: 128, // размер одной карты в пикселях
};
