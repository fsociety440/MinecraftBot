<div align="right">
  <a href="README.md">🇷🇺 Русский</a> | 🇬🇧 English
</div>

# 🤖 Minecraft Telegram Manager Bot

This project is a powerful system for managing Minecraft bots directly from **Telegram**. The bot is perfectly suited for automating routines on anarchy or survival servers, farming, scouting, and simply monitoring your accounts from your phone when you are away from your PC.

## ✨ Key Features

* **📱 Full Control via Telegram:** Add, remove, connect, and disconnect bots through a convenient UI menu.
* **👥 Multi-Account Support:** Manage an unlimited number of bots simultaneously from a single chat.
* **🚨 Radar & Anti-Grief (Panic Mode):** The bot constantly scans its render distance. If an unknown player (not in the whitelist) appears, the bot instantly disconnects from the server to save your gear and sends an emergency notification to Telegram.
* **🛡 Whitelist & "Master" System:** Configure a list of trusted players that the bot won't run away from. Assign a "Master" so the bot listens to their commands via in-game private messages (PM).
* **⛏ Auto-Miner for 3×3 Drills:** The bot quarries in a serpentine pattern layer by layer, repairs the drill with XP bottles, eats, and tosses junk. See [Miner](#-miner).
* **⚔️ Combat & Farming Macros:**
  * **Auto-attack (Farming):** The bot attacks nearby mobs and players.
  * **Auto-eat:** Command the bot to grab food in its off-hand (`возьми еду`), allowing it to eat and attack simultaneously.
  * **Compass Tracking:** Automatically uses the compass to track the nearest players for PvP.
  * **Custom Macros:** Configure slot combinations (e.g., armor swapping, using potions/ender pearls) directly from Telegram.
* **🖼 GUI Menu Support (Captchas, Mode Selection):** The bot intercepts in-game GUI menus and forwards them to Telegram as clickable inline buttons. Easily pass captchas or join game modes right from your phone!
* **📊 Global Monitoring:** A pinned message in Telegram that updates in real-time, displaying the health (HP) and hunger levels of all your online bots.
* **🎒 Inventory & Slot Management:** Select the active hotbar slot via Telegram.
* **👁 Gaze Direction Control:** Easily change the bot's viewing angle (pitch/yaw) by pasting the `Facing` line from the F3 debug screen.

## 🚀 Installation and Setup

### 1. Prerequisites
* [Node.js](https://nodejs.org/) (version 18 or higher)
* A Telegram Bot Token (get it from [@BotFather](https://t.me/botfather) in Telegram)
* Your personal Telegram Chat ID (can be found via bots like [@userinfobot](https://t.me/userinfobot))

### 2. Clone and Install Dependencies
Clone the repository and install the required libraries:
```bash
git clone https://github.com/fsociety440/MinecraftBot.git
cd MinecraftBot
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root folder of the project and add your credentials:
```env
TG_TOKEN=your_botfather_token_here
TG_CHAT_ID=your_personal_chat_id
```
`TG_CHAT_ID` is required: the bot only obeys commands from this chat. If you don't know your
chat_id, start the bot and message it — your id will be printed to the console.
Other settings (miner, farm, reconnect) are listed in `.env.example`.

### 4. Run the Bot
```bash
node index.js
```

## 🕹 How to Use
1. Run the `node index.js` script.
2. Go to your bot in Telegram and send the `/menu` command.
3. The main menu will appear, where you can add your first Minecraft bot by specifying its username.
4. Configure the "Master" (Хозяин) and the Whitelist in the **⚙️ Settings** (Настройки) menu.
5. Click **"Connect"** (Подключиться) to join the server.

## ⛏ Miner

**Start.** Place the bot where you want to dig and face it the right way (**👁 Взгляд** — paste
the `Facing` line from F3). Put the drill, XP bottles, food and the sphere (player head) in its
inventory — the sphere goes to the off-hand automatically. Press **⛏ Вкл Шахта**.

**How it digs.**
1. Hits the block at head level on the face toward itself — the drill clears a 3×3 wall and the
   bot steps forward. It cuts up to 3 walls ahead, then walks through them in one move.
2. Blocked (bedrock, barrier, protected region, lava or water nearby, a drop) — shifts 3 blocks
   sideways and comes back along the next lane. Lanes are adjacent, nothing is skipped.
3. Can't shift either — the layer is done: it digs 3 blocks down and does the next layer.
4. Started on top of the mine — goes down right away instead of walking the surface.
5. Without a drill it works the same, just with a 1×2 tunnel.

**On its own** it repairs the drill with XP bottles at ≤ 100 durability (needs Mending), eats at
hunger ≤ 14, and tosses stone/dirt/gravel when ≤ 2 slots are free (keys, spheres and unknown
items are kept). After a teleport or an anti-cheat setback it continues from the new spot.

**It always reports why it stopped:** mine finished (no way forward, sideways or down), no
progress for 30 s, drill almost broken with nothing to repair it, no pickaxe, death or
disconnect. The miner doesn't run together with farming or invisibility — they fight over the
bot's controls.

Tuning (lane length, layer depth, food and repair thresholds) — `MINER_*` in `.env.example`.

## 💬 In-Game PM Commands
If you have set the Master's username, you can message the bot via in-game private messages:
* `иди ко мне` — The bot will try to walk towards you (if it can see you).
* `иди ко мне [X] [Y] [Z]` — If the bot cannot see you, provide your coordinates, and it will navigate there.
* `возьми еду` — The bot will search its inventory for food, equip it in its off-hand, and continue its current tasks.

## 🧪 Tests
```bash
npm test
```
The miner is tested without a server on a world simulator (`test/sim.js`), including real
mineflayer physics, with lava, protected regions, no drill, repair, eating and junk tossing.

## 🛠 Technologies
* `mineflayer` — A powerful API for creating Minecraft bots.
* `node-telegram-bot-api` — Interacting with the Telegram API.
* `mineflayer-pathfinder` — Pathfinding and world navigation.

---
*Enjoy your automated farming!* 🚀
