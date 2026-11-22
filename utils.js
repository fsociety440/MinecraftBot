/**
 * utils.js — мелкие общие помощники, без зависимостей.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ждёт промис не дольше ms. По таймауту бросает ошибку; сам промис при этом
 * не отменяется, поэтому вызывающий обязан сам прибрать за ним (stopDigging и т.п.).
 */
function withTimeout(promise, ms, label = 'операция') {
  let timer;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // проигравший гонку промис не должен уронить процесс
  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`таймаут: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Экранирование для parse_mode 'Markdown' (legacy) в Telegram.
 * Там спецсимволы только _ * ` [ — остальные обратные слэши видны в тексте.
 */
function escapeMarkdown(text) {
  return String(text).replace(/([_*`[])/g, '\\$1');
}

/**
 * Строка Facing из F3 (градусы) → yaw/pitch mineflayer (радианы).
 * F3: yaw 0 = юг и растёт по часовой, pitch +90 = взгляд вниз.
 * mineflayer: yaw 0 = север и растёт против часовой, pitch +π/2 = вверх.
 */
function f3ToMineflayer(yawDeg, pitchDeg) {
  return {
    yaw: Math.PI - (yawDeg * Math.PI) / 180,
    pitch: (-pitchDeg * Math.PI) / 180,
  };
}

module.exports = { sleep, withTimeout, escapeMarkdown, f3ToMineflayer };
