const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
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

    this.minerEnabled = false;
    this.isMining = false;
    this.badBlocks = new Map();

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
      this.antibotCheckPassed = true;
      this.bot.physicsEnabled = true;
      console.log(`[MC ${this.username}] windowOpen: "${window.title}"`);
      this.sendCurrentWindowMenu();
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

        let rawName = item.customName;
        let name = this.extractJsonText(rawName);
        if (!name.trim()) {
          name = this.extractJsonText(item.displayName || item.name || `Item#${item.type}`);
        }

        const lore = (item.nbt?.value?.display?.value?.Lore?.value?.value || [])
          .map(l => this.stripColorCodes(this.extractJsonText(l)));

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
      let mouseButton = 0; // Default to Left Click
      const item = this.openWindow.slots[slotIndex];
      if (item) {
        let name = this.extractJsonText(item.customName);
        if (!name.trim()) name = this.extractJsonText(item.displayName || item.name || '');
        
        const lore = (item.nbt?.value?.display?.value?.Lore?.value?.value || [])
          .map(l => this.extractJsonText(l)).join(' ');
        
        const fullText = (name + ' ' + lore).toLowerCase();
        if (fullText.includes('пкм') || fullText.includes('правая') || fullText.includes('right click')) {
          mouseButton = 1;
        }
      }

      await this.bot.clickWindow(slotIndex, mouseButton, 0);
      this.tg.sendMessage(`👆 [${this.username}] Нажал на слот ${slotIndex} (${mouseButton === 1 ? 'ПКМ' : 'ЛКМ'})`);

      // Сервер может обновить содержимое текущего окна без отправки нового windowOpen.
      // Ждём 1.5 секунды и отправляем обновлённое меню, если окно всё ещё открыто.
      setTimeout(() => {
        if (this.openWindow) {
          this.sendCurrentWindowMenu();
        }
      }, 1500);

    } catch (err) {
      if (err.message && err.message.includes("Server didn't respond to transaction for clicking on slot")) {
        // Сервер часто не присылает подтверждение транзакции в кастомных меню, но клик проходит
        setTimeout(() => {
          if (this.openWindow) {
            this.sendCurrentWindowMenu();
          }
        }, 1500);
        return;
      }
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

  // --- Auto Miner ---

  startMiner() {
    this.antibotCheckPassed = true;
    this.bot.physicsEnabled = true;
    this.minerEnabled = true;
    if (this.isMining) return;
    this.isMining = true;
    this.badBlocks.clear();
    this.tg.sendMessage(`⛏ [${this.username}] Авто-Шахта ВКЛЮЧЕНА`);
    this.mineLoop();
  }

  stopMiner() {
    this.minerEnabled = false;
    this.isMining = false;
    if (this.bot && this.bot.pathfinder) this.bot.pathfinder.stop();
    if (this.bot) try { this.bot.stopDigging(); } catch (_) {}
    this.tg.sendMessage(`🛑 [${this.username}] Авто-Шахта ВЫКЛЮЧЕНА`);
  }

  async clearJunk() {
    if (!this.bot || !this.bot.inventory) return;
    if (this.bot.inventory.emptySlotCount() > 8) return; // Keep if >= 9 slots free

    const keepItems = [
      'netherite_pickaxe', 'diamond_pickaxe', 'experience_bottle', 'player_head',
      'diamond', 'emerald', 'gold_ingot', 'iron_ingot', 'raw_gold', 'raw_iron',
      'coal', 'lapis_lazuli', 'redstone', 'netherite_scrap', 'netherite_ingot', 'ancient_debris',
      'tripwire_hook'
    ];

    const items = this.bot.inventory.items();
    for (const item of items) {
      if (!this.isMining) break;
      if (!keepItems.includes(item.name)) {
        try {
          await this.bot.tossStack(item);
          await this.sleep(200);
        } catch (e) {}
      }
    }
  }

  async equipPickaxe() {
    if (!this.bot || !this.bot.inventory) return false;
    // Unequip pickaxe from off-hand if it's there
    const offHand = this.bot.inventory.slots[45];
    if (offHand && offHand.name.includes('pickaxe')) {
      try { await this.bot.unequip('off-hand'); await this.sleep(200); } catch (_) {}
    }
    const tiers = ['netherite_pickaxe', 'diamond_pickaxe'];
    for (const name of tiers) {
      const pick = this.bot.inventory.items().find(i => i.name === name);
      if (pick) {
        try { await this.bot.equip(pick, 'hand'); return true; } catch (_) {}
      }
    }
    const held = this.bot.heldItem;
    return !!(held && tiers.includes(held.name));
  }

  async checkAndRepairPickaxe() {
    if (!this.bot || !this.bot.inventory) return true;
    const held = this.bot.heldItem;
    if (!held || !held.name.includes('pickaxe') || held.durabilityUsed === undefined) return true;
    
    const remaining = held.maxDurability - held.durabilityUsed;
    if (remaining > 100) return true;

    const bottles = this.bot.inventory.items().find(i => i.name === 'experience_bottle');
    if (!bottles) {
      // Нет пузырьков и кирка почти сломана — стоп
      this.tg.sendMessage(`⚠️ [${this.username}] Кирка ломается (${remaining}), но нет пузырьков опыта! Шахта остановлена.`);
      this.stopMiner();
      return false;
    }

    this.tg.sendMessage(`♻️ [${this.username}] Починка кирки (прочность: ${remaining})...`);
    
    try {
      // Смотрим вниз чтобы пузырьки падали под ноги
      await this.bot.look(this.bot.entity.yaw, Math.PI / 2, true);
      await this.sleep(100);
      
      await this.bot.equip(bottles, 'off-hand');
      while (this.isMining) {
        const currentHeld = this.bot.heldItem;
        if (!currentHeld || !currentHeld.name.includes('pickaxe')) break; // Кирка пропала
        
        const currentRemaining = currentHeld.maxDurability - currentHeld.durabilityUsed;
        if (currentRemaining > currentHeld.maxDurability - 20) break; // Починили

        const hasBottle = this.bot.inventory.slots[45] && this.bot.inventory.slots[45].name === 'experience_bottle';
        if (!hasBottle) {
           const moreBottles = this.bot.inventory.items().find(i => i.name === 'experience_bottle');
           if (!moreBottles) break; // Пузырьки кончились — выходим, продолжаем копать
           await this.bot.equip(moreBottles, 'off-hand');
        }

        this.bot.activateItem(true); // Right click with off-hand
        await this.sleep(200);
      }
      this.bot.deactivateItem();
      
      // Возвращаем сферу (голову) в левую руку
      const head = this.bot.inventory.items().find(i => i.name === 'player_head');
      if (head) {
        try { await this.bot.equip(head, 'off-hand'); } catch (_) {}
      } else {
        try { await this.bot.unequip('off-hand'); } catch (_) {}
      }
      
      this.tg.sendMessage(`✅ [${this.username}] Кирка починена!`);
      return true;
    } catch (err) {
      this.tg.sendMessage(`❌ [${this.username}] Ошибка починки: ${err.message}`);
      return true; // Продолжаем копать даже при ошибке
    }
  }

  async mineLoop() {
    const mcData = require('minecraft-data')(this.bot.version);
    const move = new Movements(this.bot, mcData);
    move.allowFreeFall = true;
    move.canDig = true; // Бот будет сам прокапывать путь
    move.allow1by1towers = false;
    move.maxDropDown = 6;
    move.scafoldingBlocks = [];
    this.bot.pathfinder.setMovements(move);

    const targetBlocks = ['diamond_ore', 'emerald_ore', 'gold_ore', 'iron_ore', 'coal_ore', 'lapis_ore', 'redstone_ore', 'netherite_ore', 'ancient_debris'];
    const targetIds = targetBlocks.map(name => this.bot.registry.blocksByName[name]?.id).filter(id => id != null);

    // Перехватываем bot.dig — если бот на лестнице, сначала зажимаем Shift, потом копаем
    const originalDig = this.bot.dig.bind(this.bot);
    this.bot.dig = async (block, forceLook, digFace) => {
      const pos = this.bot.entity?.position;
      if (!pos) return originalDig(block, forceLook, digFace);
      
      const blockAtFeet = this.bot.blockAt(pos);
      const blockAtHead = this.bot.blockAt(pos.offset(0, 1, 0));
      const onLadder = (blockAtFeet && (blockAtFeet.name.includes('ladder') || blockAtFeet.name.includes('vine'))) ||
                        (blockAtHead && (blockAtHead.name.includes('ladder') || blockAtHead.name.includes('vine')));
      
      if (onLadder) {
        this.bot.setControlState('sneak', true);
        await this.sleep(150); // Дать время зафиксироваться
      }
      
      try {
        return await originalDig(block, forceLook, digFace);
      } finally {
        if (onLadder) {
          this.bot.setControlState('sneak', false);
        }
      }
    };

    let lastDigTime = Date.now();

    while (this.isMining && this.bot && this.isConnected) {
      try {
        if (!this.bot.entity || !this.bot.entity.position) { await this.sleep(1000); continue; }

        // Если за 12 секунд ни одного блока не сломано — перезапуск итерации
        if (Date.now() - lastDigTime > 12000) {
          if (this.bot.pathfinder) this.bot.pathfinder.stop();
          this.bot.clearControlStates();
          try { this.bot.stopDigging(); } catch(_) {}
          lastDigTime = Date.now();
          await this.sleep(500);
          continue;
        }

        this.bot.clearControlStates();
        await this.clearJunk();
        if (!this.isMining) break;

        const hasPick = await this.equipPickaxe();
        if (!hasPick) {
          this.tg.sendMessage(`❌ [${this.username}] Нет алмазной/незеритовой кирки!`);
          this.stopMiner();
          break;
        }

        const repaired = await this.checkAndRepairPickaxe();
        if (!repaired) break;

        // Поиск руды
        const botPos = this.bot.entity.position;
        let found = this.bot.findBlocks({ matching: targetIds, maxDistance: 32, count: 128 });
        
        const now = Date.now();
        for (const [k, exp] of this.badBlocks) {
          if (now > exp) this.badBlocks.delete(k);
        }
        
        found = found.filter(pos => !this.badBlocks.has(`${pos.x},${pos.y},${pos.z}`));
        if (found.length === 0) {
          await this.sleep(1000);
          continue;
        }

        found.sort((a, b) => botPos.distanceTo(a) - botPos.distanceTo(b));
        const targetPos = found[0];
        const key = `${targetPos.x},${targetPos.y},${targetPos.z}`;

        // Берем голову в левую руку
        const offHand = this.bot.inventory.slots[45];
        if (!offHand || offHand.name !== 'player_head') {
          const head = this.bot.inventory.items().find(i => i.name === 'player_head');
          if (head) {
            try { await this.bot.equip(head, 'off-hand'); } catch (_) {}
          }
        }

        // Подход к блоку (патфайндер будет прокапывать путь)
        let navDone = false;
        const navPromise = this.bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
        navPromise.then(() => navDone = true).catch(() => navDone = true);

        let bestDist = botPos.distanceTo(targetPos);
        let noProgressTicks = 0;
        
        while (!navDone && this.isMining) {
          await this.sleep(500);
          
          // Проверка починки на ходу
          const held = this.bot.heldItem;
          if (held && held.name.includes('pickaxe') && held.durabilityUsed !== undefined) {
            if (held.maxDurability - held.durabilityUsed < 100) {
              if (this.bot.pathfinder) this.bot.pathfinder.stop();
              navDone = true;
              break;
            }
          }

          // Проверка idle 12 сек (даже во время навигации)
          if (Date.now() - lastDigTime > 12000) {
            if (this.bot.pathfinder) this.bot.pathfinder.stop();
            navDone = true;
            break;
          }
          
          // Проверка застревания
          const curDist = this.bot.entity.position.distanceTo(targetPos);
          if (curDist < bestDist - 0.2) {
            bestDist = curDist;
            noProgressTicks = 0;
          } else {
            noProgressTicks++;
            if (noProgressTicks >= 8) { // 4 секунды без приближения
              if (this.bot.pathfinder) this.bot.pathfinder.stop();
              this.bot.clearControlStates();
              this.badBlocks.set(key, Date.now() + 22000);
              navDone = true;
              break;
            }
          }
        }

        if (!this.isMining) break;

        const dist = this.bot.entity.position.distanceTo(targetPos);
        if (dist <= 5.5) {
          const block = this.bot.blockAt(targetPos);
          if (block && block.type !== 0 && block.name !== 'air' && block.name !== 'cave_air') {
            try {
              await this.bot.dig(block, true);
              lastDigTime = Date.now(); // Успешно сломали блок
            } catch (err) {
              try { this.bot.stopDigging(); } catch(_) {}
              this.badBlocks.set(key, Date.now() + 22000);
            }
          }
        } else {
          this.badBlocks.set(key, Date.now() + 22000);
        }

      } catch (err) {
        console.error(`[MC ${this.username}] mineLoop error:`, err);
        await this.sleep(1000);
      }
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
