/**
 * config.js — загрузка конфигурации из .env
 * Все настройки бота хранятся здесь.
 */

require('dotenv').config();

module.exports = {
  // ─── Minecraft ────────────────────────────────────────────────────────────
  MC_HOST: process.env.MC_HOST || '127.0.0.1',   // IP хаба (можно менять через /setip)
  MC_PORT: parseInt(process.env.MC_PORT || '25565', 10),
  MC_USERNAME: process.env.MC_USERNAME || 'MyBot',
  MC_VERSION: '1.16.5',

  // ─── Telegram ─────────────────────────────────────────────────────────────
  TG_TOKEN: process.env.TG_TOKEN || '',           // Токен бота от @BotFather
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',       // Ваш личный chat_id

  // ─── Фарм ────────────────────────────────────────────────────────────────
  FARM_INTERVAL_MS: parseInt(process.env.FARM_INTERVAL_MS || '1500', 10), // мс между ударами

  // ─── Переподключение ──────────────────────────────────────────────────────
  RECONNECT_DELAY_MS: parseInt(process.env.RECONNECT_DELAY_MS || '30000', 10),

  // ─── Капча ────────────────────────────────────────────────────────────────
  CAPTCHA_COLS: 4,   // колонок в сетке карт
  CAPTCHA_ROWS: 3,   // строк в сетке карт
  CAPTCHA_MAP_SIZE: 128, // размер одной карты в пикселях
};
