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

## 💬 In-Game PM Commands
If you have set the Master's username, you can message the bot via in-game private messages:
* `иди ко мне` — The bot will try to walk towards you (if it can see you).
* `иди ко мне [X] [Y] [Z]` — If the bot cannot see you, provide your coordinates, and it will navigate there.
* `возьми еду` — The bot will search its inventory for food, equip it in its off-hand, and continue its current tasks.

## 🛠 Technologies
* `mineflayer` — A powerful API for creating Minecraft bots.
* `node-telegram-bot-api` — Interacting with the Telegram API.
* `mineflayer-pathfinder` — Pathfinding and world navigation.

---
*Enjoy your automated farming!* 🚀
