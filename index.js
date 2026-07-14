const TelegramManager = require('./telegramBot');
const MinecraftBot = require('./mcBot');

// Инициализируем Telegram-бота
const tgManager = new TelegramManager();

tgManager.onAddBot = (username, host, port) => {
  const mcBot = new MinecraftBot(username, host, port, tgManager);
  tgManager.registerBot(mcBot);
  mcBot.start();
};

tgManager.init();
tgManager.loadBots();
