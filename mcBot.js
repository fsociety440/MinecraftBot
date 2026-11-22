const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const cfg = require('./config');
const captcha = require('./captcha');
const { Miner } = require('./miner');
const { sleep } = require('./utils');

// Сколько после входа действуют обходы BotFilter (пустота вместо незагруженных
// чанков и заморозка физики в комнате капчи). Потом они только мешают.
const ANTIBOT_PHASE_MS = 5 * 60 * 1000;

const MANUAL_STOP = 'по команде';

function fakeAir(pos) {
  return { position: pos, type: 0, name: 'air', boundingBox: 'empty', transparent: true, shapes: [] };
}

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
    this.isConnected = false;
    this.reconnectTimer = null;
    this.openWindow = null;

    this.farmInterval = null;
    this.autoEatInterval = null;
    this.invisEnabled = false;
    this.lastInvisWarn = 0;
    this.macroSequence = [];
    this.macroEnabled = false;

    /** @type {Miner | null} */
    this.miner = null;

    this.antibotCheckPassed = false;
    this.loginAt = 0;
    this.radarKicked = false;
  }

  get minerEnabled() {
    return !!(this.miner && this.miner.running);
  }

  /** Идёт ли ещё проверка антибота (в это время действуют обходы BotFilter). */
  inAntibotPhase() {
    return !this.antibotCheckPassed && Date.now() - this.loginAt < ANTIBOT_PHASE_MS;
  }

  start() {
    this.createBot();
  }

  stop() {
    this.isConnected = false;
    this.stopFarm();
    this.stopMiner('бот отключён');
    this.stopAutoEat();
    if (this.invisEnabled) this.stopInvis();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.bot) {
      try { this.bot.quit(); } catch (_) {}
      this.bot = null;
    }
  }

  scheduleReconnect() {
    this.stopFarm();
    this.stopMiner('потеряно соединение');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[MC ${this.username}] Переподключение…`);
      this.tg.sendMessage(`🔄 [${this.username}] Переподключаюсь…`);
      this.createBot();
    }, cfg.RECONNECT_DELAY_MS);
  }

  connectNow() {
    this.stopFarm();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.tg.sendMessage(`🔄 [${this.username}] Подключение...`);
    this.createBot();
  }

  createBot() {
    if (this.bot) {
      try { this.bot.quit(); } catch (_) {}
    }
    this.isConnected = false;
    this.radarKicked = false; // Сбрасываем триггер радара при каждом новом подключении
    this.antibotCheckPassed = false;
    this.openWindow = null;

    console.log(`[MC ${this.username}] Подключаюсь к ${this.host}:${this.port}…`);

    const bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      version: cfg.MC_VERSION,
      auth: 'offline',
      hideErrors: false,
      physicsEnabled: true,
    });
    this.bot = bot;

    bot._client.on('kick_disconnect', (packet) => {
      console.warn(`[MC ${this.username} RAW kick_disconnect]`, JSON.stringify(packet));
    });

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
      console.log(`[MC ${this.username}] Spawned!`);
      // Движения для «иди ко мне»: без паркура (частая причина откатов античита).
      const moves = new Movements(bot);
      moves.allowParkour = false;
      moves.maxDropDown = 3;
      bot.pathfinder.setMovements(moves);

      if (this.macroEnabled && this.macroSequence && this.macroSequence.length > 0) {
        setTimeout(() => this.executeMacro(), 3000);
      }
    });

    bot.once('login', () => {
      const isFirstLogin = !this.isConnected;
      this.isConnected = true;
      this.loginAt = Date.now();
      if (isFirstLogin) {
        if (this.tg.activeBotId === this.id) this.tg.showBotMenu(this.id);
        this.tg.sendMessage(`✅ Бот *${this.tg.escapeMarkdown(this.username)}* зашел на сервер \n\`${this.host}:${this.port}\``, {
          parse_mode: 'Markdown',
        });
      }
      console.log(`[MC ${this.username}] Login`);

      captcha.initMapListener(bot);
      bot.physicsEnabled = true;

      // ОБХОД БОТФИЛЬТРА. mineflayer не считает физику, пока бот в незагруженном
      // чанке, а BotFilter проверяет падение в пустоте. Поэтому в фазе антибота
      // незагруженные блоки выдаём за воздух. После неё — честный null, иначе
      // после каждого телепорта бот проваливается в ещё не пришедшие чанки.
      if (bot.world && !bot.world._originalGetBlock) {
        const world = bot.world;
        const original = world.getBlock.bind(world);
        world._originalGetBlock = original;
        world.getBlock = (pos) => {
          let block = null;
          try { block = original(pos); } catch (_) {}
          if (block) return block;
          return this.inAntibotPhase() ? fakeAir(pos) : null;
        };
      }

      bot.on('forcedMove', () => {
        // Комната капчи: замораживаем физику, чтобы бот не падал, пока вводим капчу.
        // Только в фазе антибота — иначе любой /spawn или откат античита ниже y=100
        // навсегда выключал физику.
        if (!this.inAntibotPhase()) return;
        if (bot.entity && bot.entity.position && bot.entity.position.y < 100 && bot.physicsEnabled) {
          bot.physicsEnabled = false;
          bot.clearControlStates();
          console.log(`[MC ${this.username}] Teleported to captcha room. Physics disabled.`);
        }
      });

      let captchaDebounce = null;
      let lastCaptchaTime = 0;

      const triggerCaptchaCheck = () => {
        if (captchaDebounce) clearTimeout(captchaDebounce);
        captchaDebounce = setTimeout(async () => {
          captchaDebounce = null;
          if (!bot.entity || !bot.entity.position) return;

          const nearbyFrames = Object.values(bot.entities).filter((e) => {
            if (!e || !e.name || !e.position) return false;
            if (e.name !== 'item_frame' && e.name !== 'glow_item_frame') return false;
            return e.position.distanceTo(bot.entity.position) <= 10;
          });

          const needed = Math.floor((cfg.CAPTCHA_COLS * cfg.CAPTCHA_ROWS) / 2);
          if (nearbyFrames.length >= needed) {
            const now = Date.now();
            if (now - lastCaptchaTime < 4000) return;
            lastCaptchaTime = now;
            console.log(`[MC ${this.username}] Капча (${nearbyFrames.length} рамок)`);
            this.tg.sendMessage(`🗺 [${this.username}] Собираю капчу…`);
            await captcha.captureAndSendCaptcha(bot, this);
          }
        }, 1500);
      };

      bot.on('entitySpawn', (entity) => {
        if (!entity || !entity.name) return;
        if (entity.name === 'item_frame' || entity.name === 'glow_item_frame') triggerCaptchaCheck();
      });

      bot.on('map_updated', () => {
        if (bot.entity && bot.entity.position && bot.entity.position.y < 100 && !bot.physicsEnabled && !this.antibotCheckPassed) {
          triggerCaptchaCheck();
        }
      });

      // Радар
      const checkRadar = (entity) => {
        if (!this.tg.radarEnabled || this.radarKicked) return;
        if (!entity || entity.type !== 'player' || !entity.username) return;

        const username = entity.username;
        if (username === this.username) return; // сам себя не пугается
        if (this.tg.masterName && username.toLowerCase() === this.tg.masterName.toLowerCase()) return; // хозяин

        const isWhitelisted = this.tg.whitelist.some((w) => w.toLowerCase() === username.toLowerCase());
        if (!isWhitelisted) {
          this.radarKicked = true;
          const dist = bot.entity && bot.entity.position && entity.position
            ? Math.round(bot.entity.position.distanceTo(entity.position))
            : '?';
          const esc = (t) => this.tg.escapeMarkdown(t);
          this.tg.sendMessage(`🚨 [ВНИМАНИЕ] Бот ${esc(this.username)} обнаружил чужого игрока: *${esc(username)}* (Дистанция: ${dist}). Ливаю с сервера!`, { parse_mode: 'Markdown' });
          this.stop();
        }
      };

      bot.on('entitySpawn', checkRadar);
      bot.on('entityMoved', checkRadar);
    });

    bot.on('windowOpen', (window) => {
      this.openWindow = window;
      this.antibotCheckPassed = true;
      bot.physicsEnabled = true;
      console.log(`[MC ${this.username}] windowOpen: "${window.title}"`);
      this.sendCurrentWindowMenu();
    });

    bot.on('windowClose', () => {
      this.openWindow = null;
    });

    bot.on('death', () => {
      // Возрождение делает сам mineflayer (опция respawn включена по умолчанию).
      // Раньше здесь был вызов несуществующего bot.spawn(): он бросал исключение
      // и обрывал этот самый авто-респаун — бот висел на экране смерти.
      console.log(`[MC ${this.username}] Умер`);
      this.stopMiner('бот умер');
      this.tg.sendMessage(`💀 [${this.username}] Бот умер! Возрождаюсь...`);
    });

    bot.on('message', (jsonMsg) => {
      if (typeof jsonMsg.toAnsi !== 'function') return;
      const text = jsonMsg.toString();
      const lower = text.toLowerCase();

      if (
        lower.includes('уважаемый игрок') ||
        lower.includes('vk.me') ||
        lower.includes('привяжите свой аккаунт') ||
        lower.includes('бесплатно восстанавливать пароль')
      ) {
        return; // Игнорируем рекламу привязки ВК
      }

      const checkPassedPhrases = ['проверка пройдена', 'успешно пройдена', 'спасибо за подтверждение', 'вы успешно прошли проверку', 'добро пожаловать', 'вы прошли', 'welcome', 'verification passed', 'check passed', 'успешно', 'авторизуйтесь', '/login', '/reg', 'пароль'];
      const isCheckPassed = checkPassedPhrases.some((p) => lower.includes(p));

      if (isCheckPassed && !this.antibotCheckPassed) {
        this.antibotCheckPassed = true;
        bot.physicsEnabled = true;
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

      if (this.tg.masterName) this.handleMasterMessage(text);
    });

    bot.on('kicked', (reason) => {
      this.isConnected = false;
      const msg = this.tryParseReason(reason);
      console.warn(`[MC ${this.username}] Kicked: ${msg}`);
      if (!this.radarKicked) {
        const sec = Math.round(cfg.RECONNECT_DELAY_MS / 1000);
        this.tg.sendMessage(`⛔ [${this.username}] Кикнут: *${this.tg.escapeMarkdown(msg)}*\nПереподключение через ${sec} сек`, { parse_mode: 'Markdown' });
        this.scheduleReconnect();
      }
    });

    bot.on('end', (reason) => {
      if (!this.isConnected) return;
      this.isConnected = false;
      if (this.tg.activeBotId === this.id) this.tg.showBotMenu(this.id);
      this.tg.sendMessage(`🔌 [${this.username}] Отключен: ${reason}`);
      if (!this.radarKicked) this.scheduleReconnect();
    });

    bot.on('error', (err) => {
      console.error(`[MC ${this.username}] Error:`, err.message);
    });
  }

  // --- Команды хозяина (ЛС в игре) ---

  handleMasterMessage(text) {
    const bot = this.bot;
    const pmMatch = text.match(/^\[(.*?)\s*->\s*[Яя]\]\s*(.*)$/i);
    if (!pmMatch) return;
    const sender = pmMatch[1].trim();
    const content = pmMatch[2].trim();
    if (sender.toLowerCase() !== this.tg.masterName.toLowerCase()) return;
    const contentLower = content.toLowerCase();

    if (contentLower === 'выйди' || contentLower === 'ливай') {
      this.tg.sendMessage(`👑 [${this.username}] Выполняю команду хозяина: Отключаюсь.`);
      this.stop();
    } else if (contentLower.startsWith('иди ко мне')) {
      this.stopMiner('команда хозяина');
      const coordsMatch = contentLower.match(/иди ко мне\s+([-\d]+)\s+([-\d]+)\s+([-\d]+)/);
      if (coordsMatch) {
        const [x, y, z] = coordsMatch.slice(1, 4).map((n) => parseInt(n, 10));
        this.tg.sendMessage(`👑 [${this.username}] Иду к хозяину на координаты ${x} ${y} ${z}...`);
        bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
      } else {
        const player = bot.players[this.tg.masterName];
        if (player && player.entity) {
          this.tg.sendMessage(`👑 [${this.username}] Вижу хозяина в радиусе прорисовки! Иду...`);
          bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
        } else {
          const msg = 'Не вижу хозяина, отправьте координаты в формате "иди ко мне x y z"';
          this.tg.sendMessage(`👑 [${this.username}] ${msg}`);
          bot.chat(`/m ${sender} ${msg}`);
        }
      }
    } else if (contentLower === 'стоп') {
      this.tg.sendMessage(`👑 [${this.username}] Остановка всех действий.`);
      this.stopFarm();
      this.stopMiner('команда хозяина');
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    } else if (contentLower === 'возьми еду') {
      this.tg.sendMessage(`👑 [${this.username}] Ищу еду...`);
      const foods = ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop', 'bread', 'apple', 'carrot', 'baked_potato'];
      let foundFood = null;
      for (const f of foods) {
        foundFood = bot.inventory.items().find((item) => item.name === f);
        if (foundFood) break;
      }
      if (foundFood) {
        bot.equip(foundFood, 'off-hand')
          .then(() => this.tg.sendMessage(`👑 [${this.username}] Взял ${foundFood.name} в левую руку!`))
          .catch((e) => this.tg.sendMessage(`👑 [${this.username}] Ошибка при экипировке: ${e.message}`));
      } else {
        this.tg.sendMessage(`👑 [${this.username}] Еды в инвентаре не найдено.`);
      }
    } else {
      bot.chat(content); // Дублируем в глобальный чат
    }
  }

  // --- Actions ---

  sendCurrentWindowMenu() {
    if (!this.openWindow) return;
    if (this._menuTimeout) clearTimeout(this._menuTimeout);

    this._menuTimeout = setTimeout(() => {
      if (!this.openWindow) return;
      const window = this.openWindow;
      const items = [];
      for (let i = 0; i < window.slots.length; i++) {
        const item = window.slots[i];
        if (!item) continue;

        let name = this.extractJsonText(item.customName);
        if (!name.trim()) {
          name = this.extractJsonText(item.displayName || item.name || `Item#${item.type}`);
        }

        const lore = (item.nbt?.value?.display?.value?.Lore?.value?.value || [])
          .map((l) => this.stripColorCodes(this.extractJsonText(l)));

        items.push({ slot: i, name: this.stripColorCodes(name), lore });
      }

      // Проверка на дубликаты (чтобы не отправлять дважды одно и то же меню)
      const menuHash = JSON.stringify(items);
      if (this._lastMenuHash !== menuHash) {
        this._lastMenuHash = menuHash;
        this.tg.sendServerMenu(this, items);
      }
    }, 500); // Ждём 500мс после события, чтобы сервер успел прислать предметы
  }

  async useCompass() {
    if (!this.bot) return false;
    try {
      const compass = this.bot.inventory.items().find((item) => item.name === 'compass');
      if (!compass) {
        this.tg.sendMessage(`⚠️ [${this.username}] В инвентаре нет компаса.`);
        return false;
      }
      await this.bot.equip(compass, 'hand');
      await sleep(500);
      this.bot.activateItem();
      this.tg.sendMessage(`🧭 [${this.username}] Открываю компас...`);
      return true;
    } catch (err) {
      this.tg.sendMessage(`❌ [${this.username}] Ошибка компаса: ${err.message}`);
      return false;
    }
  }

  async executeMacro() {
    if (!this.bot) return;
    this.tg.sendMessage(`🤖 [${this.username}] Выполняю макрос...`);
    if (await this.useCompass()) await sleep(2000); // Ждем, пока откроется меню компаса

    for (const slot of this.macroSequence) {
      if (!this.bot) break;
      this.tg.sendMessage(`🤖 [${this.username}] Макрос: клик слота ${slot}...`);
      await this.clickSlot(slot);
      await sleep(1500); // Задержка между кликами
    }
    this.tg.sendMessage(`🤖 [${this.username}] Макрос завершен.`);
  }

  async clickSlot(slotIndex) {
    if (!this.bot) return;
    if (!this.openWindow) {
      this.tg.sendMessage(`❌ [${this.username}] Нет открытого окна`);
      return;
    }
    const refreshMenu = () => setTimeout(() => {
      if (this.openWindow) this.sendCurrentWindowMenu();
    }, 1500);
    try {
      let mouseButton = 0; // Default to Left Click
      const item = this.openWindow.slots[slotIndex];
      if (item) {
        let name = this.extractJsonText(item.customName);
        if (!name.trim()) name = this.extractJsonText(item.displayName || item.name || '');

        const lore = (item.nbt?.value?.display?.value?.Lore?.value?.value || [])
          .map((l) => this.extractJsonText(l)).join(' ');

        const fullText = (name + ' ' + lore).toLowerCase();
        if (fullText.includes('пкм') || fullText.includes('правая') || fullText.includes('right click')) {
          mouseButton = 1;
        }
      }

      await this.bot.clickWindow(slotIndex, mouseButton, 0);
      this.tg.sendMessage(`👆 [${this.username}] Нажал на слот ${slotIndex} (${mouseButton === 1 ? 'ПКМ' : 'ЛКМ'})`);
      // Сервер может обновить содержимое текущего окна без отправки нового windowOpen.
      refreshMenu();
    } catch (err) {
      if (err.message && err.message.includes("Server didn't respond to transaction for clicking on slot")) {
        // Сервер часто не присылает подтверждение транзакции в кастомных меню, но клик проходит
        refreshMenu();
        return;
      }
      this.tg.sendMessage(`❌ [${this.username}] Ошибка слота: ${err.message}`);
    }
  }

  startFarm() {
    if (this.farmInterval) return;
    this.stopMiner('включён фарм');
    this.farmInterval = setInterval(() => {
      if (!this.bot || !this.isConnected || !this.bot.entity) return;
      try {
        // Проверяем сущность строго в перекрестии прицела (как обычный автокликер)
        const target = this.bot.entityAtCursor(4.0);
        if (target && (target.type === 'mob' || target.type === 'hostile' || target.type === 'animal' || (target.type === 'player' && target.username !== this.bot.username))) {
          this.bot.attack(target);
        } else {
          this.bot.swingArm('right');
        }
      } catch (_) {}
    }, cfg.FARM_INTERVAL_MS);
    this.tg.sendMessage(`⚔️ [${this.username}] Фарм Включен (автокликер перед собой)`);
  }

  stopFarm() {
    if (this.farmInterval) {
      clearInterval(this.farmInterval);
      this.farmInterval = null;
      this.tg.sendMessage(`🛑 [${this.username}] Фарм Выключен`);
    }
  }

  /** Авто-еда для фарма: ест то, что лежит в левой руке, если это еда. */
  startAutoEat() {
    if (this.autoEatInterval) return;
    let isEating = false;
    this.autoEatInterval = setInterval(async () => {
      const bot = this.bot;
      if (!bot || !this.isConnected || isEating || this.minerEnabled) return; // шахта ест сама
      const off = bot.inventory && bot.inventory.slots[45];
      const isFood = off && bot.registry.foodsByName && bot.registry.foodsByName[off.name];
      if (bot.food < 18 && isFood) {
        isEating = true;
        try {
          bot.activateItem(true);
          await sleep(1800);
          bot.deactivateItem();
        } catch (_) {}
        isEating = false;
      }
    }, 3000);
    this.tg.sendMessage(`🍔 [${this.username}] Авто-Еда Включена (ест из левой руки при сытости < 18)`);
  }

  stopAutoEat() {
    if (this.autoEatInterval) {
      clearInterval(this.autoEatInterval);
      this.autoEatInterval = null;
      this.tg.sendMessage(`🛑 [${this.username}] Авто-Еда Выключена`);
    }
  }

  setSlot(slotIndex) {
    if (!this.bot) return;
    try {
      this.bot.setQuickBarSlot(slotIndex); // hotbar is 0-8 in mineflayer
      this.tg.sendMessage(`🎒 [${this.username}] Выбран слот ${slotIndex + 1}`);
    } catch (e) {
      this.tg.sendMessage(`❌ Ошибка выбора слота: ${e.message}`);
    }
  }

  async equipOffHand() {
    if (!this.bot) return;
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
          face: 255,
        });
        this.tg.sendMessage(`🎒 [${this.username}] Предмет перенесён (пакетом).`);
      } catch (err2) {
        this.tg.sendMessage(`❌ [${this.username}] Ошибка переноса: ${e.message}`);
      }
    }
  }

  lookAt(yaw, pitch) {
    if (!this.bot) return;
    try {
      this.bot.look(yaw, pitch, true);
    } catch (e) {}
  }

  sendToChat(text) {
    if (!this.bot) return;
    try {
      this.bot.chat(text);
      this.tg.sendMessage(`💬 [${this.username}] Написал: ${text}`);
    } catch (e) {}
  }

  // --- Шахта (логика — в miner.js) ---

  startMiner() {
    const bot = this.bot;
    if (!bot || !this.isConnected || !bot.entity) {
      this.tg.sendMessage(`❌ [${this.username}] Бот не в игре — шахту не запустить`);
      return;
    }
    if (this.minerEnabled) return;
    // Раз игрок запускает шахту, бот уже на сервере: антибот позади, физика нужна.
    this.antibotCheckPassed = true;
    bot.physicsEnabled = true;
    // Режимы, которые дерутся за управление ботом.
    this.stopFarm();
    if (this.invisEnabled) this.stopInvis();

    const miner = new Miner(bot, {
      notify: (t) => this.tg.sendMessage(`[${this.username}] ${t}`),
      log: (t) => console.log(`[MC ${this.username}] шахта: ${t}`),
      options: cfg.MINER,
    });
    miner.onStop = (reason) => {
      this.tg.sendMessage(`🛑 [${this.username}] Шахта остановлена: ${reason}\n📊 ${miner.summary()}`);
      if (reason !== MANUAL_STOP && this.tg.activeBotId === this.id) this.tg.showBotMenu(this.id);
    };
    this.miner = miner;
    miner.start();
  }

  stopMiner(reason = MANUAL_STOP) {
    if (this.miner) this.miner.stop(reason);
  }

  // --- Invisibility ---

  startInvis() {
    if (this.invisEnabled) return;
    this.stopMiner('включена невидимость'); // шахта и Shift мешают друг другу
    this.invisEnabled = true;
    this.tg.sendMessage(`👻 [${this.username}] Невидимость ВКЛЮЧЕНА (AFK Shift)`);
    if (this.bot) this.bot.setControlState('sneak', true);
    this.invisLoop();
  }

  stopInvis() {
    this.invisEnabled = false;
    if (this.bot) this.bot.setControlState('sneak', false);
    this.tg.sendMessage(`🛑 [${this.username}] Невидимость ВЫКЛЮЧЕНА`);
  }

  async invisLoop() {
    while (this.invisEnabled && this.bot && this.isConnected) {
      try {
        if (!this.bot.entity) { await sleep(1000); continue; }

        // Постоянно поддерживаем нажатым Shift
        if (!this.bot.controlState.sneak) this.bot.setControlState('sneak', true);

        // Проверяем эффект невидимости (ID = 14)
        const hasInvis = !!(this.bot.entity.effects && this.bot.entity.effects[14]);

        if (!hasInvis) {
          const potion = this.bot.inventory.items().find((i) =>
            i.name === 'potion' &&
            i.nbt && i.nbt.value && i.nbt.value.Potion && i.nbt.value.Potion.value &&
            i.nbt.value.Potion.value.includes('invisibility'));

          if (potion) {
            this.tg.sendMessage(`🧪 [${this.username}] Пью зелье невидимости...`);
            await this.bot.equip(potion, 'hand');
            this.bot.activateItem();
            await sleep(2000); // Питье занимает около 1.6 сек
            this.bot.deactivateItem();
            await sleep(500);
          } else if (Date.now() - this.lastInvisWarn > 60000) {
            // Если зелий нет, пишем предупреждение (не чаще 1 раза в минуту)
            this.tg.sendMessage(`⚠️ [${this.username}] Эффект невидимости спал, а зелий в инвентаре НЕТ!`);
            this.lastInvisWarn = Date.now();
          }
        }
      } catch (err) {
        console.error(`[MC ${this.username}] invisLoop error:`, err);
      }
      await sleep(2000);
    }
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
      if (Array.isArray(obj.extra)) res += obj.extra.map((o) => this.extractJsonText(o)).join('');
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
}

module.exports = MinecraftBot;
