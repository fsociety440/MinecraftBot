const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const BOTS_FILE = path.join(__dirname, 'bots.json');

class TelegramManager {
  constructor() {
    this.tg = new TelegramBot(cfg.TG_TOKEN, { polling: true });
    this.bots = new Map(); // id -> MinecraftBot instance
    this.userState = null;
    this.activeBotId = null;

    this.globalMonitorEnabled = false;
    this.globalMonitorInterval = null;
    this.globalMonitorMsgId = null;

    this.masterName = null;
    this.radarEnabled = false;
    this.whitelist = [];
  }

  init() {
    this.tg.on('message', (msg) => this.handleMessage(msg));
    this.tg.on('callback_query', (query) => this.handleCallback(query));
    console.log('[TG] Telegram-менеджер запущен. Отправьте /menu');
    this.sendMessage('🤖 Бот запущен! Отправьте /menu для управления.');
  }

  registerBot(mcBot) {
    this.bots.set(mcBot.id, mcBot);
    this.saveBots();
  }

  removeBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      bot.stop();
      this.bots.delete(botId);
      this.saveBots();
    }
  }

  saveBots() {
    const botsArray = [];
    for (const bot of this.bots.values()) {
      botsArray.push({ username: bot.username, host: bot.host, port: bot.port, macroSequence: bot.macroSequence, macroEnabled: bot.macroEnabled });
    }
    const data = {
      masterName: this.masterName,
      radarEnabled: this.radarEnabled,
      whitelist: this.whitelist,
      bots: botsArray
    };
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
  }

  loadBots() {
    if (fs.existsSync(BOTS_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        let botsData = raw;
        if (!Array.isArray(raw)) {
          this.masterName = raw.masterName || null;
          this.radarEnabled = raw.radarEnabled || false;
          this.whitelist = raw.whitelist || [];
          botsData = raw.bots || [];
        }
        for (const b of botsData) {
          if (this.onAddBot) this.onAddBot(b.username, b.host, b.port, false, b.macroSequence, b.macroEnabled);
        }
      } catch (e) {
        console.error('[TG] Failed to load bots:', e);
      }
    }
  }

  // --- Send methods ---
  async sendMessage(text, opts = {}) {
    try {
      return await this.tg.sendMessage(cfg.TG_CHAT_ID, text, opts);
    } catch (e) {
      console.error('[TG] sendMessage error:', e.message);
      return null;
    }
  }

  async editMessage(msgId, text, opts = {}) {
    try {
      return await this.tg.editMessageText(text, { chat_id: cfg.TG_CHAT_ID, message_id: msgId, ...opts });
    } catch (e) {
      throw e; // Expected to be caught by caller
    }
  }

  async sendPhoto(photo, opts = {}) {
    try {
      return await this.tg.sendPhoto(cfg.TG_CHAT_ID, photo, opts);
    } catch (e) {
      console.error('[TG] sendPhoto error:', e.message);
      return null;
    }
  }

  sendServerMenu(bot, items) {
    if (!items.length) {
      this.sendMessage(`⚠️ [${bot.username}] Меню пустое.`);
      return;
    }

    const validItems = items.filter(it => {
      const lower = it.name.toLowerCase();
      if (lower.includes('stained glass pane') || lower.includes('stained_glass_pane') || lower.includes('стеклянная панель')) return false;
      if (it.name.trim() === '' && (!it.lore || it.lore.length === 0)) return false;
      return true;
    });

    let text = `🖥 *Меню сервера (${bot.username}):*\n\n`;
    validItems.forEach(it => {
      let itemText = `• Слот ${it.slot}: *${this.escapeMarkdown(it.name)}*`;
      if (it.lore && it.lore.length > 0) {
        itemText += `\n  ℹ️ ${this.escapeMarkdown(it.lore.join(' | ').substring(0, 200))}`;
      }
      itemText += '\n';

      if (text.length + itemText.length > 3800) {
        this.sendMessage(text, { parse_mode: 'Markdown' });
        text = '';
      }
      text += itemText;
    });

    const buttons = [];
    for (let i = 0; i < validItems.length; i += 3) {
      const row = validItems.slice(i, i + 3).map(it => ({
        text: `[${it.slot}] ${it.name.substring(0, 15)}`,
        callback_data: `slot:${bot.id}:${it.slot}`,
      }));
      buttons.push(row);
    }

    this.sendMessage(text || `Меню (${bot.username}):`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  sendCaptchaImage(bot, imageBuffer) {
    this.sendPhoto(imageBuffer, {
      caption: `🖼 *Капча (${bot.username})*\nЧто на картинке?`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✍️ Ввести капчу', callback_data: `enter_captcha:${bot.id}` },
        ]],
      },
    });
  }

  // --- Global Monitoring ---
  setGlobalMonitor(enabled) {
    this.globalMonitorEnabled = enabled;
    if (!enabled && this.globalMonitorInterval) {
      clearInterval(this.globalMonitorInterval);
      this.globalMonitorInterval = null;
      if (this.globalMonitorMsgId) {
        try {
          this.tg.unpinChatMessage(cfg.TG_CHAT_ID, { message_id: this.globalMonitorMsgId });
        } catch (e) {
          console.error('[TG] Failed to unpin message:', e.message);
        }
      }
      this.globalMonitorMsgId = null;
      this.showMainMenu();
      return;
    }




    if (enabled && !this.globalMonitorInterval) {
      this.showMainMenu();
      this.globalMonitorInterval = setInterval(async () => {
        if (this.bots.size === 0) return;
        let text = '📊 *Мониторинг ботов:*\n';
        for (const bot of this.bots.values()) {
          if (!bot.isConnected) {
            text += `• ${this.escapeMarkdown(bot.username)}: ❌ Оффлайн\n`;
          } else {
            text += `• ${this.escapeMarkdown(bot.username)}: ХП ${Math.round(bot.bot.health || 0)}/20 | ЕДА ${Math.round(bot.bot.food || 0)}/20\n`;
          }
        }
        
        if (!this.globalMonitorMsgId) {
          const sent = await this.sendMessage(text, { parse_mode: 'Markdown' });
          if (sent) {
            this.globalMonitorMsgId = sent.message_id;
            try {
              await this.tg.pinChatMessage(cfg.TG_CHAT_ID, sent.message_id, { disable_notification: true });
            } catch (e) {
              console.error('[TG] Failed to pin message:', e.message);
            }
          }
        } else {
          try {
            await this.editMessage(this.globalMonitorMsgId, text, { parse_mode: 'Markdown' });
          } catch (e) {
            if (e.message.includes('message is not modified')) return;
            if (e.message.includes('message to edit not found')) {
              this.globalMonitorMsgId = null;
            }
          }
        }
      }, 3000);
    }
  }

  // --- GUI MENUS ---

  showMainMenu() {
    this.userState = null;
    this.activeBotId = null;
    const keyboard = [
      [{ text: '➕ Добавить бота' }, { text: '🤖 Список ботов' }],
      [{ text: this.globalMonitorEnabled ? '🔕 Выкл Общий Мониторинг' : '📡 Вкл Общий Мониторинг' }],
      [{ text: '⚙️ Настройки' }]
    ];
    this.sendMessage('🛠 *Главное меню*', { 
      parse_mode: 'Markdown', 
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true } 
    });
  }

  showSettingsMenu() {
    this.userState = null;
    this.activeBotId = null;
    const keyboard = [
      [{ text: this.masterName ? `👑 Хозяин: ${this.masterName}` : '👑 Хозяин (не задан)' }],
      [{ text: `🚨 Радар: ${this.radarEnabled ? 'ВКЛ' : 'ВЫКЛ'}` }, { text: `🛡 Вайт-лист: ${this.whitelist.length} чел.` }],
      [{ text: '⬅️ Назад в Главное меню' }]
    ];
    this.sendMessage('⚙️ *Настройки системы*\n\nНастройте глобальные параметры для всех ботов.', { 
      parse_mode: 'Markdown', 
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true } 
    });
  }

  showBotList() {
    this.userState = null;
    this.activeBotId = null;
    if (this.bots.size === 0) {
      this.sendMessage('Ни одного бота нет. Добавьте нового!', {
        reply_markup: { keyboard: [[{ text: '➕ Добавить бота' }], [{ text: '⬅️ Назад в Главное меню' }]], resize_keyboard: true }
      });
      return;
    }

    const keyboard = [];
    let row = [];
    for (const bot of this.bots.values()) {
      row.push({ text: `🎮 ${bot.username}` });
      if (row.length === 2) {
        keyboard.push(row);
        row = [];
      }
    }
    if (row.length > 0) keyboard.push(row);
    keyboard.push([{ text: '⬅️ Назад в Главное меню' }]);

    this.sendMessage('📋 *Выберите бота:*', { parse_mode: 'Markdown', reply_markup: { keyboard, resize_keyboard: true } });
  }

  showBotMenu(botId) {
    const bot = this.bots.get(botId);
    if (!bot) {
      this.sendMessage('❌ Бот не найден.');
      return;
    }

    this.activeBotId = botId;

    const text = `🤖 *Бот:* ${this.escapeMarkdown(bot.username)}\n🌐 *Сервер:* ${this.escapeMarkdown(bot.host)}:${bot.port}\n📶 *Статус:* ${bot.isConnected ? '✅ Онлайн' : '❌ Оффлайн'}\n⚔️ *Фарм:* ${bot.farmInterval ? 'ВКЛ' : 'ВЫКЛ'}\n🍔 *Еда:* ${bot.autoEatInterval ? 'ВКЛ' : 'ВЫКЛ'}`;
    
    const keyboard = [
      [{ text: bot.isConnected ? '🔴 Отключиться' : '🟢 Подключиться' }],
      [{ text: bot.farmInterval ? '🛑 Выкл Фарм' : '⚔️ Вкл Фарм' }, { text: bot.minerEnabled ? '🛑 Выкл Шахта' : '⛏ Вкл Шахта' }, { text: bot.invisEnabled ? '🛑 Выкл Инвиз' : '👻 Вкл Инвиз' }],
      [{ text: '🧭 Компас' }, { text: bot.autoEatInterval ? '🛑 Выкл ЕДА' : '🍎 Вкл ЕДА' }, { text: '🎒 Слоты' }, { text: '👁 Взгляд' }],
      [{ text: '🤖 Макросы' }, { text: '💬 Чат' }],
      [{ text: '🗑 Удалить' }, { text: '⬅️ Назад к списку' }]
    ];

    this.sendMessage(text, { 
      parse_mode: 'Markdown', 
      reply_markup: { 
        keyboard: keyboard,
        resize_keyboard: true,
        is_persistent: true
      } 
    });
  }

  showSlotsMenu(botId) {
    const bot = this.bots.get(botId);
    if (!bot) return;

    const keyboard = [
      [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }],
      [{ text: '6' }, { text: '7' }, { text: '8' }, { text: '9' }, { text: '⬅️ В левую руку' }],
      [{ text: '⬅️ Назад к боту' }]
    ];

    this.sendMessage(`🎒 *Слоты бота ${this.escapeMarkdown(bot.username)}:*`, {
      parse_mode: 'Markdown',
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true }
    });
  }

  showMacroMenu(botId) {
    const bot = this.bots.get(botId);
    if (!bot) return;
    this.activeBotId = botId;

    const seqStr = bot.macroSequence && bot.macroSequence.length > 0 ? bot.macroSequence.join(', ') : 'Пусто';
    const text = `🤖 *Макросы бота ${this.escapeMarkdown(bot.username)}*\n\nТекущая последовательность: \`Компас\` -> \`${seqStr}\`\nСтатус макроса: ${bot.macroEnabled ? '✅ ВКЛ' : '❌ ВЫКЛ'}`;

    const keyboard = [
      [{ text: '📝 Создать макрос' }, { text: '🗑 Удалить макрос' }],
      [{ text: bot.macroEnabled ? 'ВЫКЛ Макрос' : 'ВКЛ Макрос' }],
      [{ text: '⬅️ Назад к боту' }]
    ];

    this.sendMessage(text, {
      parse_mode: 'Markdown',
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true }
    });
  }


  // --- Event Handlers ---

  handleMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();

    if (text === '/menu' || text === '/start' || text === '⬅️ Назад в Главное меню') {
      this.showMainMenu();
      return;
    }

    if (this.userState) {
      if (this.userState.action === 'CREATE_MACRO') {
        const bot = this.bots.get(this.userState.botId);
        if (bot) {
          const matches = text.match(/\d+/g);
          if (matches) {
            bot.macroSequence = matches.map(n => parseInt(n, 10));
            bot.macroEnabled = true;
            this.saveBots();
            this.sendMessage('✅ Макрос сохранен и включен!');
          } else {
            bot.macroSequence = [];
            this.saveBots();
            this.sendMessage('⚠️ Не найдено чисел, макрос очищен.');
          }
          this.userState = null;
          this.showMacroMenu(bot.id);
        }
        return;
      }
      if (this.userState.action === 'ADD_BOT_NAME') {
        const name = text.split(' ')[0];
        this.userState = { action: 'ADD_BOT_IP', name };
        this.sendMessage('Никнейм: ' + name + '\nТеперь отправьте IP сервера (например: 127.0.0.1 25565 или просто 127.0.0.1):');
        return;
      }
      if (this.userState.action === 'ADD_BOT_IP') {
        const parts = text.split(' ');
        const host = parts[0];
        const port = parseInt(parts[1] || '25565', 10);
        const name = this.userState.name;
        this.userState = null;
        this.sendMessage('⏳ Запускаю бота ' + name + ' на ' + host + ':' + port + '...');
        if (this.onAddBot) this.onAddBot(name, host, port, true);
        this.showMainMenu();
        return;
      }
      if (this.userState.action === 'CAPTCHA') {
        const bot = this.bots.get(this.userState.botId);
        this.userState = null;
        if (bot) {
          bot.sendToChat(text);
          this.sendMessage('✅ [' + bot.username + '] Капча отправлена: ' + text);
        }
        return;
      }
      if (this.userState.action === 'LOOK') {
        const bot = this.bots.get(this.userState.botId);
        if (bot) {
          const match = text.match(/([\d.-]+)\s*\/\s*([\d.-]+)/);
          if (match) {
            const mcYaw = parseFloat(match[1]);
            const mcPitch = parseFloat(match[2]);
            const yaw = mcYaw * (Math.PI / 180);
            const pitch = mcPitch * (Math.PI / 180);
            bot.lookAt(yaw, pitch);
            this.sendMessage('👁 [' + bot.username + '] Взгляд направлен (yaw=' + mcYaw + ', pitch=' + mcPitch + ')');
          } else {
            this.sendMessage('❌ Неверный формат. Ожидалось число/число (например: 123.4 / 56.7)', { parse_mode: 'Markdown' });
          }
        }
        this.userState = null;
        return;
      }
      if (this.userState.action === 'CHAT') {
        const bot = this.bots.get(this.userState.botId);
        if (text === '/stopchat') {
           this.userState = null;
           this.sendMessage('Чат отключен.');
           return;
        }
        if (bot) {
          bot.sendToChat(text);
        }
        return;
      }
      if (this.userState.action === 'ADD_MASTER') {
        const name = text.split(' ')[0];
        this.masterName = name;
        this.saveBots();
        this.userState = null;
        this.sendMessage(`✅ Хозяин установлен: *${name}*`, { parse_mode: 'Markdown' });
        this.showSettingsMenu();
        return;
      }
      if (this.userState.action === 'WHITELIST_ACTION') {
        if (text === '➕ Добавить') {
          this.userState = { action: 'ADD_WHITELIST' };
          this.sendMessage('Введите никнейм игрока для добавления в вайт-лист:', { reply_markup: { remove_keyboard: true } });
        } else if (text === '➖ Удалить') {
          this.userState = { action: 'REMOVE_WHITELIST' };
          this.sendMessage('Введите никнейм игрока для удаления из вайт-листа:', { reply_markup: { remove_keyboard: true } });
        } else if (text === '⬅️ Назад в Настройки') {
          this.showSettingsMenu();
        }
        return;
      }
      if (this.userState.action === 'ADD_WHITELIST') {
        const name = text.split(' ')[0];
        if (!this.whitelist.includes(name)) {
           this.whitelist.push(name);
           this.saveBots();
           this.sendMessage(`✅ Игрок *${name}* добавлен в вайт-лист!`, { parse_mode: 'Markdown' });
        } else {
           this.sendMessage(`⚠️ Игрок *${name}* уже в вайт-листе!`, { parse_mode: 'Markdown' });
        }
        this.showSettingsMenu();
        return;
      }
      if (this.userState.action === 'REMOVE_WHITELIST') {
        const name = text.split(' ')[0];
        const idx = this.whitelist.indexOf(name);
        if (idx !== -1) {
           this.whitelist.splice(idx, 1);
           this.saveBots();
           this.sendMessage(`✅ Игрок *${name}* удален из вайт-листа!`, { parse_mode: 'Markdown' });
        } else {
           this.sendMessage(`⚠️ Игрок *${name}* не найден в вайт-листе!`, { parse_mode: 'Markdown' });
        }
        this.showSettingsMenu();
        return;
      }
    }

    if (text === '➕ Добавить бота') {
      this.userState = { action: 'ADD_BOT_NAME' };
      this.sendMessage('Введите никнейм для нового бота:', { reply_markup: { remove_keyboard: true } });
      return;
    }

    if (text === '🤖 Список ботов' || text === '📋 Список ботов' || text === '⬅️ Назад к списку') {
      this.showBotList();
      return;
    }

    if (text === '📡 Вкл Общий Мониторинг' || text === '🔕 Выкл Общий Мониторинг') {
      this.setGlobalMonitor(!this.globalMonitorEnabled);
      return;
    }

    if (text === '⚙️ Настройки') {
      this.showSettingsMenu();
      return;
    }

    if (text === '⬅️ Назад в Главное меню') {
      this.showMainMenu();
      return;
    }

    if (text.startsWith('👑 Хозяин')) {
      this.userState = { action: 'ADD_MASTER' };
      this.sendMessage('Введите ваш точный никнейм в Minecraft:\n(Боты будут слушаться только личных сообщений от этого игрока)', { reply_markup: { remove_keyboard: true } });
      return;
    }

    if (text.startsWith('🚨 Радар:')) {
      this.radarEnabled = !this.radarEnabled;
      this.saveBots();
      this.showSettingsMenu();
      return;
    }

    if (text.startsWith('🛡 Вайт-лист:')) {
      this.userState = { action: 'WHITELIST_ACTION' };
      const wlText = this.whitelist.length > 0 ? this.whitelist.join(', ') : 'Пусто';
      this.sendMessage(`🛡 *Текущий вайт-лист:*\n${wlText}\n\nЧто хотите сделать?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [[{ text: '➕ Добавить' }, { text: '➖ Удалить' }], [{ text: '⬅️ Назад в Настройки' }]],
          resize_keyboard: true
        }
      });
      return;
    }

    if (text.startsWith('🎮 ')) {
      const username = text.substring(3);
      for (const [id, bot] of this.bots.entries()) {
        if (bot.username === username) {
          this.showBotMenu(id);
          return;
        }
      }
    }

    if (this.activeBotId && this.bots.has(this.activeBotId)) {
      const bot = this.bots.get(this.activeBotId);
      
      if (text === '⚔️ Вкл Фарм' || text === '🛑 Выкл Фарм') {
        bot.farmInterval ? bot.stopFarm() : bot.startFarm();
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '⛏ Вкл Шахта' || text === '🛑 Выкл Шахта') {
        bot.minerEnabled ? bot.stopMiner() : bot.startMiner();
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '👻 Вкл Инвиз' || text === '🛑 Выкл Инвиз') {
        bot.invisEnabled ? bot.stopInvis() : bot.startInvis();
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '🍎 Вкл ЕДА' || text === '🛑 Выкл ЕДА') {
        bot.autoEatInterval ? bot.stopAutoEat() : bot.startAutoEat();
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '🧭 Компас') { bot.useCompass(); return; }
      if (text === '🎒 Слоты') { this.showSlotsMenu(this.activeBotId); return; }
      if (text === '⬅️ В левую руку') { bot.equipOffHand(); return; }
      if (text === '⬅️ Назад к боту') { this.showBotMenu(this.activeBotId); return; }
      if (text === '🤖 Макросы') { this.showMacroMenu(this.activeBotId); return; }
      if (text === '🗑 Удалить макрос') { 
        bot.macroSequence = []; 
        this.saveBots();
        this.sendMessage('🗑 Макрос удален для ' + bot.username);
        this.showMacroMenu(this.activeBotId);
        return; 
      }
      if (text === 'ВКЛ Макрос' || text === 'ВЫКЛ Макрос') {
        bot.macroEnabled = !bot.macroEnabled;
        this.saveBots();
        this.showMacroMenu(this.activeBotId);
        return;
      }
      if (text === '📝 Создать макрос') {
        this.userState = { action: 'CREATE_MACRO', botId: this.activeBotId };
        this.sendMessage('✏️ Введите номера слотов через пробел или запятую.\nНапример: 12 15 4\n\n(При выполнении бот всегда сначала использует компас, а затем прокликает эти слоты.)');
        return;
      }
      if (text === '👁 Взгляд') {
        this.userState = { action: 'LOOK', botId: this.activeBotId };
        this.sendMessage('👁 Управление взглядом\nСкопируйте строчку Facing из F3...');
        return;
      }
      if (text === '💬 Чат') {
        this.userState = { action: 'CHAT', botId: this.activeBotId };
        this.sendMessage('💬 Режим чата для ' + bot.username + ' активирован.\nНапишите /stopchat для выхода.');
        return;
      }
      if (text === '🔴 Отключиться') {
        bot.stop();
        this.sendMessage('🔌 [' + bot.username + '] Бот отключен от сервера.');
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '🟢 Подключиться') {
        if (!bot.bot || !bot.isConnected) {
          bot.connectNow();
          this.showBotMenu(this.activeBotId);
        } else {
          this.sendMessage('⚠️ [' + bot.username + '] Бот уже в сети!');
        }
        return;
      }
      if (text === '🗑 Удалить') { 
        this.removeBot(this.activeBotId);
        this.activeBotId = null;
        this.sendMessage('🗑 Бот удален.');
        this.showBotList();
        return;
      }
      if (/^[1-9]$/.test(text)) {
        bot.setSlot(parseInt(text, 10) - 1);
        return;
      }
    }

    if (text.startsWith('/say ') || text.startsWith('/login ') || text.startsWith('/register ') || text.startsWith('/reg ') || text.startsWith('/l ')) {
      let msgToSend = text;
      if (text.startsWith('/say ')) {
        msgToSend = text.substring(5);
      }
      let count = 0;
      for (const bot of this.bots.values()) {
        if (bot.isConnected) {
          bot.sendToChat(msgToSend);
          count++;
        }
      }
      this.sendMessage('📢 Отправлено в чат ' + count + ' ботам.');
      return;
    }
  }

  async handleCallback(query) {
    const data = query.data || '';
    const parts = data.split(':');
    const cmd = parts[0];
    const botId = parts[1];

    try {
      if (cmd === 'main_menu') this.showMainMenu();
      else if (cmd === 'list_bots') this.showBotList();
      else if (cmd === 'add_bot_start') {
        this.userState = { action: 'ADD_BOT_NAME' };
        this.sendMessage('Введите никнейм для нового бота:');
      }
      else if (cmd === 'bot_menu') {
        this.showBotMenu(botId);
      }
      else if (cmd === 'toggle_farm') {
        const bot = this.bots.get(botId);
        if (bot) {
          bot.farmInterval ? bot.stopFarm() : bot.startFarm();
          this.showBotMenu(botId); // refresh menu
        }
      }
      else if (cmd === 'toggle_monitor') {
        const bot = this.bots.get(botId);
        if (bot) {
          bot.setMonitor(!bot.monitorEnabled);
          this.showBotMenu(botId);
        }
      }
      else if (cmd === 'use_compass') {
        const bot = this.bots.get(botId);
        if (bot) bot.useCompass();
      }
      else if (cmd === 'enter_chat') {
        const bot = this.bots.get(botId);
        if (bot) {
          this.userState = { action: 'CHAT', botId };
          this.sendMessage(`💬 Режим чата для ${bot.username} активирован. Все ваши сообщения будут отправляться на сервер.\nДля выхода напишите /stopchat`);
        }
      }
      else if (cmd === 'enter_look') {
        const bot = this.bots.get(botId);
        if (bot) {
          this.userState = { action: 'LOOK', botId };
          this.sendMessage(`👁 *Управление взглядом*\nСкопируйте строчку Facing из F3 (где написаны градусы через слэш XX/XX) и отправьте сюда.\nНапример: \`Facing: south 123.4 / 56.7\` или просто \`123.4 / 56.7\``, { parse_mode: 'Markdown' });
        }
      }
      else if (cmd === 'eat_item') {
        const bot = this.bots.get(botId);
        if (bot) {
          bot.eatItem();
        }
      }
      else if (cmd === 'enter_captcha') {
        const bot = this.bots.get(botId);
        if (bot) {
          this.userState = { action: 'CAPTCHA', botId };
          this.sendMessage(`✍️ Напишите цифры с капчи для ${bot.username}:`);
        }
      }
      else if (cmd === 'slot') {
        const bot = this.bots.get(botId);
        const slotIdx = parseInt(parts[2], 10);
        if (bot) bot.clickSlot(slotIdx);
      }
      else if (cmd === 'reconnect') {
        const bot = this.bots.get(botId);
        if (bot) bot.scheduleReconnect();
      }
      else if (cmd === 'delete_bot') {
        this.removeBot(botId);
        this.sendMessage('🗑 Бот удален.');
        this.showBotList();
      }

      await this.tg.answerCallbackQuery(query.id);
    } catch (e) {
      console.error('[TG] Callback error:', e.message);
    }
  }

  escapeMarkdown(text) {
    return String(text).replace(/([_*\[\]()~`])/g, '\\$1');
  }
}

module.exports = TelegramManager;
