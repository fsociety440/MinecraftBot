const TelegramManager = require('./telegramBot');
const MinecraftBot = require('./mcBot');

// Инициализируем Telegram-бота
const tgManager = new TelegramManager();

tgManager.onAddBot = (username, host, port, autoStart = true, macroSequence = [], macroEnabled = false) => {
  const mcBot = new MinecraftBot(username, host, port, tgManager);
  mcBot.macroSequence = macroSequence || [];
  mcBot.macroEnabled = macroEnabled || false;
  tgManager.registerBot(mcBot);
  if (autoStart) {
    mcBot.start();
  }
};

tgManager.init();
tgManager.loadBots();
