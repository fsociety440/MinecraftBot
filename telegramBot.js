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
    const data = [];
    for (const bot of this.bots.values()) {
      data.push({ username: bot.username, host: bot.host, port: bot.port });
    }
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
  }

  loadBots() {
    if (fs.existsSync(BOTS_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        for (const b of data) {
          if (this.onAddBot) this.onAddBot(b.username, b.host, b.port);
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
          if (sent) this.globalMonitorMsgId = sent.message_id;
        } else {
          try {
            await this.editMessage(this.globalMonitorMsgId, text, { parse_mode: 'Markdown' });
          } catch (e) {
            if (e.message.includes('message is not modified')) return;
            if (e.message.includes('message to edit not found')) this.globalMonitorMsgId = null;
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
      [{ text: this.globalMonitorEnabled ? '🔕 Выкл Общий Мониторинг' : '📡 Вкл Общий Мониторинг' }]
    ];
    this.sendMessage('🛠 *Главное меню*', { 
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

    const text = `🤖 *Бот:* ${this.escapeMarkdown(bot.username)}\n🌐 *Сервер:* ${this.escapeMarkdown(bot.host)}:${bot.port}\n📶 *Статус:* ${bot.isConnected ? '✅ Онлайн' : '❌ Оффлайн'}\n⚔️ *Фарм:* ${bot.farmInterval ? 'ВКЛ' : 'ВЫКЛ'}`;
    
    const keyboard = [
      [{ text: bot.farmInterval ? '🛑 Выкл Фарм' : '⚔️ Вкл Фарм' }, { text: '🧭 Компас' }, { text: '🍎 Покушать' }],
      [{ text: '🎒 Слоты' }, { text: '👁 Взгляд' }, { text: '💬 Чат' }],
      [{ text: '🔄 Реконнект' }, { text: '🗑 Удалить' }, { text: '⬅️ Назад к списку' }]
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


  // --- Event Handlers ---

  handleMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();

    if (text === '/menu' || text === '/start' || text === '⬅️ Назад в Главное меню') {
      this.showMainMenu();
      return;
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

    // Если кликнули на бота в списке
    if (text.startsWith('🎮 ')) {
      const username = text.substring(3);
      for (const [id, bot] of this.bots.entries()) {
        if (bot.username === username) {
          this.showBotMenu(id);
          return;
        }
      }
    }

    // Reply Keyboard Handler for active bot
    if (this.activeBotId && this.bots.has(this.activeBotId)) {
      const bot = this.bots.get(this.activeBotId);
      
      if (text === '⚔️ Вкл Фарм' || text === '🛑 Выкл Фарм') {
        bot.farmInterval ? bot.stopFarm() : bot.startFarm();
        this.showBotMenu(this.activeBotId);
        return;
      }
      if (text === '🧭 Компас') { bot.useCompass(); return; }
      if (text === '🍎 Покушать') { bot.eatItem(); return; }
      if (text === '🎒 Слоты') { this.showSlotsMenu(this.activeBotId); return; }
      if (text === '⬅️ В левую руку') { bot.equipOffHand(); return; }
      if (text === '⬅️ Назад к боту') { this.showBotMenu(this.activeBotId); return; }
      if (text === '👁 Взгляд') {
        this.userState = { action: 'LOOK', botId: this.activeBotId };
        this.sendMessage(`👁 *Управление взглядом*\nСкопируйте строчку Facing из F3...`, { parse_mode: 'Markdown' });
        return;
      }
      if (text === '💬 Чат') {
        this.userState = { action: 'CHAT', botId: this.activeBotId };
        this.sendMessage(`💬 Режим чата для ${bot.username} активирован.\nНапишите /stopchat для выхода.`);
        return;
      }
      if (text === '🔄 Реконнект') { bot.scheduleReconnect(); return; }
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

    // Глобальные команды (отправляют во все боты сразу)
    if (text.startsWith('/say ') || text.startsWith('/login ') || text.startsWith('/register ') || text.startsWith('/reg ') || text.startsWith('/l ')) {
      let msgToSend = text;
      if (text.startsWith('/say ')) {
        msgToSend = text.substring(5); // убираем "/say "
      }
      let count = 0;
      for (const bot of this.bots.values()) {
        if (bot.isConnected) {
          bot.sendToChat(msgToSend);
          count++;
        }
      }
      this.sendMessage(`📢 Отправлено в чат ${count} ботам.`);
      return;
    }

    if (this.userState) {
      if (this.userState.action === 'ADD_BOT_NAME') {
        const name = text.split(' ')[0];
        this.userState = { action: 'ADD_BOT_IP', name };
        this.sendMessage(`Никнейм: ${name}\nТеперь отправьте IP сервера (например: 127.0.0.1 25565 или просто 127.0.0.1):`);
        return;
      }

      if (this.userState.action === 'ADD_BOT_IP') {
        const parts = text.split(' ');
        const host = parts[0];
        const port = parseInt(parts[1] || '25565', 10);
        const name = this.userState.name;
        
        this.userState = null;
        this.sendMessage(`⏳ Запускаю бота ${name} на ${host}:${port}...`);
        
        if (this.onAddBot) {
          this.onAddBot(name, host, port);
        }
        return;
      }

      if (this.userState.action === 'CAPTCHA') {
        const bot = this.bots.get(this.userState.botId);
        this.userState = null; // reset state
        if (bot) {
          bot.sendToChat(text);
          this.sendMessage(`✅ [${bot.username}] Капча отправлена: ${text}`);
        }
        return;
      }

      if (this.userState.action === 'LOOK') {
        const bot = this.bots.get(this.userState.botId);
        if (bot) {
          // Обрабатываем формат из F3, например "-90.0 / 12.5" или "120/45"
          const match = text.match(/([\d.-]+)\s*\/\s*([\d.-]+)/);
          if (match) {
            const mcYaw = parseFloat(match[1]);
            const mcPitch = parseFloat(match[2]);
            // Перевод из градусов майнкрафта в радианы Mineflayer:
            const yaw = mcYaw * (Math.PI / 180);
            const pitch = mcPitch * (Math.PI / 180);
            bot.lookAt(yaw, pitch);
            this.sendMessage(`👁 [${bot.username}] Взгляд направлен (yaw=${mcYaw}, pitch=${mcPitch})`);
          } else {
            this.sendMessage('❌ Неверный формат. Ожидалось число/число (например: `123.4 / 56.7`)', { parse_mode: 'Markdown' });
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
    return String(text).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
  }
}

module.exports = TelegramManager;
