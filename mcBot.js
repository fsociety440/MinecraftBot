const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const cfg = require('./config');
const captcha = require('./captcha');

class MinecraftBot {
  /**
   * @param {string} username
   * @param {string} host
   * @param {number} port
   * @param {import('./telegramBot')} tgManager
   */
  constructor(username, host, port, tgManager) {
    this.id = username + '_' + Date.now();
    this.username = username;
    this.host = host;
    this.port = port;
    this.tg = tgManager;

    this.bot = null;
    this.farmInterval = null;
    this.reconnectTimer = null;
    this.isConnected = false;
    this.openWindow = null;
    this.antibotCheckPassed = false;
    
    // Auto-monitor
    this.monitorEnabled = false;
    this.monitorInterval = null;
    this.lastMonitorMsgId = null;

    this.isEating = false;
  }

  start() {
    this.createBot();
  }

  stop() {
    this.isConnected = false;
    this.stopFarm();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bot) {
      try { this.bot.quit(); } catch (_) {}
      this.bot = null;
    }
  }

  scheduleReconnect() {
    this.stopFarm();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[MC ${this.username}] Переподключение…`);
      this.tg.sendMessage(`🔄 [${this.username}] Переподключаюсь…`);
      this.createBot();
    }, cfg.RECONNECT_DELAY_MS);
  }

  createBot() {
    if (this.bot) {
      try { this.bot.quit(); } catch (_) {}
    }
    this.isConnected = false;

    console.log(`[MC ${this.username}] Подключаюсь к ${this.host}:${this.port}…`);
    
    this.bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      version: cfg.MC_VERSION,
      auth: 'offline',
      hideErrors: false,
      physicsEnabled: true,
    });

    this.bot._client.on('kick_disconnect', (packet) => {
      console.warn(`[MC ${this.username} RAW kick_disconnect]`, JSON.stringify(packet));
    });

    this.bot._client.on('position', (packet) => {
      if (packet.teleportId !== undefined) {
        this.bot._client.write('teleport_confirm', { teleportId: packet.teleportId });
      }
    });

    this.bot.loadPlugin(pathfinder);

    this.bot.once('spawn', () => {
      this.antibotCheckPassed = false;
      console.log(`[MC ${this.username}] Spawned!`);
    });

    this.bot.on('login', () => {
      this.isConnected = true;
      console.log(`[MC ${this.username}] Login. Applying physics bypass hooks...`);
      this.tg.sendMessage(`✅ Бот *${this.escapeMarkdown(this.username)}* вошёл на сервер \`${this.host}:${this.port}\``, {
        parse_mode: 'Markdown',
      });
      
      captcha.initMapListener(this.bot);
      this.bot.physicsEnabled = true;

      // ОБХОД БОТФИЛЬТРА
      if (this.bot.world && !this.bot.world._originalGetBlock) {
        const world = this.bot.world;
        world._originalGetBlock = world.getBlock.bind(world);
        world.getBlock = (pos) => {
          try {
            const b = world._originalGetBlock(pos);
            if (b === null || b === undefined) {
              return { position: pos, type: 0, name: 'air', boundingBox: 'empty', transparent: true, shapes: [] };
            }
            return b;
          } catch (e) {
            return { position: pos, type: 0, name: 'air', boundingBox: 'empty', transparent: true, shapes: [] };
          }
        };
      }

      this.bot.on('forcedMove', () => {
        if (this.bot.entity && this.bot.entity.position && this.bot.entity.position.y < 100 && this.bot.physicsEnabled && !this.antibotCheckPassed) {
           this.bot.physicsEnabled = false;
           this.bot.clearControlStates();
           console.log(`[MC ${this.username}] Teleported to captcha room. Physics disabled.`);
        }
      });

      let captchaDebounce = null;
      let lastCaptchaTime = 0;

      const triggerCaptchaCheck = () => {
        if (captchaDebounce) clearTimeout(captchaDebounce);
        captchaDebounce = setTimeout(async () => {
          captchaDebounce = null;
          if (!this.bot.entity || !this.bot.entity.position) return;
          
          const nearbyFrames = Object.values(this.bot.entities).filter(e => {
            if (!e || !e.name) return false;
            const n = e.name;
            if (n !== 'item_frame' && n !== 'glow_item_frame') return false;
            if (!e.position) return false;
            return e.position.distanceTo(this.bot.entity.position) <= 10;
          });
          
          const needed = Math.floor((cfg.CAPTCHA_COLS * cfg.CAPTCHA_ROWS) / 2);
          if (nearbyFrames.length >= needed) {
            const now = Date.now();
            if (now - lastCaptchaTime < 4000) return;
            lastCaptchaTime = now;
            console.log(`[MC ${this.username}] Капча (${nearbyFrames.length} рамок)`);
            this.tg.sendMessage(`🗺 [${this.username}] Собираю капчу…`);
            await captcha.captureAndSendCaptcha(this.bot, this);
          }
        }, 1500);
      };

      this.bot.on('entitySpawn', (entity) => {
        if (!entity || !entity.name) return;
        if (entity.name === 'item_frame' || entity.name === 'glow_item_frame') {
          triggerCaptchaCheck();
        }
      });

      this.bot.on('map_updated', () => {
        if (this.bot.entity && this.bot.entity.position && this.bot.entity.position.y < 100 && !this.bot.physicsEnabled && !this.antibotCheckPassed) {
          triggerCaptchaCheck();
        }
      });

      // Авто-еда
      this.bot.on('health', async () => {
        if (this.bot.food < 20 && !this.isEating && this.bot.physicsEnabled) {
          this.isEating = true;
          try {
            this.bot.activateItem(true); 
            await this.sleep(2000);
            this.bot.deactivateItem();
          } catch (e) {}
          this.isEating = false;
        }
      });
    });

    this.bot.on('windowOpen', (window) => {
      this.openWindow = window;
      console.log(`[MC ${this.username}] windowOpen: "${window.title}"`);

      const items = [];
      for (let i = 0; i < window.slots.length; i++) {
        const item = window.slots[i];
        if (!item) continue;

        let rawName = item.customName;
        let name = this.extractJsonText(rawName);
        if (!name.trim()) {
          name = this.extractJsonText(item.displayName || item.name || `Item#${item.type}`);
        }

        const lore = (item.nbt?.value?.display?.value?.Lore?.value?.value || [])
          .map(l => this.stripColorCodes(this.extractJsonText(l)));

        items.push({ slot: i, name: this.stripColorCodes(name), lore });
      }

      this.tg.sendServerMenu(this, items);
    });

    this.bot.on('windowClose', () => {
      this.openWindow = null;
    });

    this.bot.on('death', () => {
      console.log(`[MC ${this.username}] Умер`);
      this.tg.sendMessage(`💀 [${this.username}] Бот умер! Возрождаюсь...`);
      this.bot.spawn();
    });

    this.bot.on('message', async (jsonMsg) => {
      if (typeof jsonMsg.toAnsi !== 'function') return;
      const text = jsonMsg.toString();
      const lower = text.toLowerCase();
      
      const checkPassedPhrases = ['проверка пройдена', 'успешно пройдена', 'спасибо за подтверждение', 'вы успешно прошли проверку', 'добро пожаловать', 'вы прошли', 'welcome', 'verification passed', 'check passed', 'успешно', 'авторизуйтесь', '/login', '/reg', 'пароль'];
      const isCheckPassed = checkPassedPhrases.some(p => lower.includes(p));

      if (isCheckPassed && !this.antibotCheckPassed) {
        this.antibotCheckPassed = true;
        this.bot.physicsEnabled = true;
        console.log(`[MC ${this.username}] Проверка пройдена`);
        this.tg.sendMessage(`✅ [${this.username}] Антибот пройден!`);
      }

      if (
        lower.includes('ошибка') || lower.includes('проверка') || lower.includes('капча') ||
        lower.includes('пароль') || lower.includes('войдите') || lower.includes('зарегистрируйтесь') ||
        lower.includes('успешно')
      ) {
        this.tg.sendMessage(`💬 [${this.username}]: ${text}`);
      }
    });

    this.bot.on('kicked', (reason) => {
      this.isConnected = false;
      const msg = this.tryParseReason(reason);
      console.warn(`[MC ${this.username}] Kicked: ${msg}`);
      this.tg.sendMessage(`⛔ [${this.username}] Кикнут: *${this.escapeMarkdown(msg)}*\nПереподключение через 30 сек`, { parse_mode: 'Markdown' });
      this.scheduleReconnect();
    });

    this.bot.on('end', (reason) => {
      if (!this.isConnected) return;
      this.isConnected = false;
      this.tg.sendMessage(`🔌 [${this.username}] Отключен: ${reason}`);
      this.scheduleReconnect();
    });

    this.bot.on('error', (err) => {
      console.error(`[MC ${this.username}] Error:`, err.message);
    });
  }

  // --- Actions ---

  async useCompass() {
    if (!this.bot || !this.isConnected) return;
    try {
      const compass = this.bot.inventory.items().find(item => item.name === 'compass');
      if (!compass) {
        this.tg.sendMessage(`🧭 [${this.username}] В инвентаре нет компаса.`);
        return;
      }
      await this.bot.equip(compass, 'hand');
      await this.sleep(500);
      this.bot.activateItem();
      this.tg.sendMessage(`🧭 [${this.username}] Открываю компас...`);
    } catch (err) {
      this.tg.sendMessage(`❌ [${this.username}] Ошибка компаса: ${err.message}`);
    }
  }

  async clickSlot(slotIndex) {
    if (!this.bot || !this.isConnected) return;
    if (!this.openWindow) {
      this.tg.sendMessage(`❌ [${this.username}] Нет открытого окна`);
      return;
    }
    try {
      await this.bot.clickWindow(slotIndex, 0, 0);
      this.tg.sendMessage(`👆 [${this.username}] Нажал на слот ${slotIndex}`);
    } catch (err) {
      this.tg.sendMessage(`❌ [${this.username}] Ошибка слота: ${err.message}`);
    }
  }

  startFarm() {
    if (this.farmInterval) return;
    this.farmInterval = setInterval(() => {
      if (!this.bot || !this.isConnected) return;
      try { this.bot.swingArm('left'); } catch (_) {}
    }, cfg.FARM_INTERVAL_MS);
    this.tg.sendMessage(`⚔️ [${this.username}] Фарм Включен`);
  }

  stopFarm() {
    if (this.farmInterval) {
      clearInterval(this.farmInterval);
      this.farmInterval = null;
      this.tg.sendMessage(`🛑 [${this.username}] Фарм Выключен`);
    }
  }

  async eatItem() {
    if (!this.bot || !this.isConnected) return;
    this.tg.sendMessage(`🍎 [${this.username}] Кушаю предмет из левой руки...`);
    try {
      this.bot.activateItem(true); 
      await this.sleep(2000);
      this.bot.deactivateItem();
    } catch (e) {
      this.tg.sendMessage(`❌ [${this.username}] Ошибка при поедании: ${e.message}`);
    }
  }

  setSlot(slotIndex) {
    if (!this.bot || !this.isConnected) return;
    try {
      // hotbar is 0-8 in mineflayer
      this.bot.setQuickBarSlot(slotIndex);
      this.tg.sendMessage(`🎒 [${this.username}] Выбран слот ${slotIndex + 1}`);
    } catch (e) {
      this.tg.sendMessage(`❌ Ошибка выбора слота: ${e.message}`);
    }
  }

  async equipOffHand() {
    if (!this.bot || !this.isConnected) return;
    try {
      const item = this.bot.heldItem;
      if (!item) {
        this.tg.sendMessage(`⚠️ [${this.username}] В руке пусто, нечего переносить!`);
        return;
      }
      await this.bot.equip(item, 'off-hand');
      this.tg.sendMessage(`🎒 [${this.username}] Предмет перенесён в левую руку.`);
    } catch (e) {
      // Fallback: send the swap packet directly if equip fails (1.16+)
      try {
        this.bot._client.write('block_dig', {
          status: 6, // swap item in hand
          location: { x: 0, y: 0, z: 0 },
          face: 255
        });
        this.tg.sendMessage(`🎒 [${this.username}] Предмет перенесён (пакетом).`);
      } catch (err2) {
        this.tg.sendMessage(`❌ [${this.username}] Ошибка переноса: ${e.message}`);
      }
    }
  }

  lookAt(yaw, pitch) {
    if (!this.bot || !this.isConnected) return;
    try {
      this.bot.look(yaw, pitch, true);
    } catch (e) {}
  }

  sendToChat(text) {
    if (!this.bot || !this.isConnected) return;
    try {
      this.bot.chat(text);
      this.tg.sendMessage(`💬 [${this.username}] Написал: ${text}`);
    } catch (e) {}
  }

  // --- Utils ---
  extractJsonText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { return obj; }
    }
    let res = '';
    if (typeof obj === 'object' && obj !== null) {
      if (typeof obj.text === 'string') res += obj.text;
      if (Array.isArray(obj.extra)) res += obj.extra.map(o => this.extractJsonText(o)).join('');
    }
    return res;
  }

  stripColorCodes(str) {
    return String(str).replace(/§[0-9a-fk-or]/gi, '').trim();
  }

  tryParseReason(reason) {
    try {
      const obj = JSON.parse(reason);
      return obj.text || obj.translate || reason;
    } catch { return String(reason); }
  }

  escapeMarkdown(text) {
    return String(text).replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = MinecraftBot;
