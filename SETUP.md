# PayIT - Setup Guide (Windows, CMD + Notepad)

This walks you through running the bot on your own PC. No coding required,
just careful copy/pasting.

## 0. Revoke the old bot token

You shared a bot token in chat earlier. Treat it as compromised:

1. Open Telegram, message **@BotFather**
2. Send `/mybots` → select your bot → **API Token** → **Revoke current token**
3. Copy the new token somewhere safe (you'll paste it into `.env` in step 4, never into chat)

## 1. Install Node.js

1. Go to https://nodejs.org and download the **LTS** installer for Windows
2. Run it, click Next through the defaults
3. Confirm it worked: open **CMD** (search "cmd" in the Start menu) and type:
   ```
   node -v
   ```
   You should see something like `v22.x.x`. You need v22.5 or newer.

## 2. Get the project folder onto your PC

Copy the whole `payit` folder (the one with `bot.js`, `package.json`, etc.)
onto your PC, e.g. to `C:\payit`.

## 3. Install dependencies

In CMD:
```
cd C:\payit
npm install
```
Wait for it to finish (no native build tools needed - this should just work).

## 4. Create your `.env` file

1. In the `C:\payit` folder, copy `.env.example` and rename the copy to `.env`
   (in File Explorer: copy/paste, then rename, making sure Windows doesn't
   leave it as `.env.txt` — you may need to enable "show file extensions" in
   View options to check)
2. Open `.env` in **Notepad** (right-click → Open with → Notepad)
3. Fill in:
   - `TELEGRAM_BOT_TOKEN` - your new token from Step 0
   - `ADMIN_TELEGRAM_IDS` - your own numeric Telegram ID (get it from @userinfobot)
4. Save and close Notepad (keep it as `.env`, not `.env.txt`)

## 5. Run the bot

In CMD:
```
npm start
```
You should see: `PayIT bot is running (Arc testnet, non-custodial)...`

Leave this CMD window open - closing it stops the bot. Open Telegram, find
your bot, and send `/start`.

## 6. First-time setup in Telegram

1. `/start` generates a brand new wallet for you and asks you to set a
   4-digit PIN
2. **Important:** right after you set your PIN, the bot shows you your
   private key ONE TIME, then auto-deletes that message after 60 seconds.
   Copy it somewhere safe immediately (a password manager, not a
   screenshot). If you ever lose your PIN and never saved this, those
   funds are gone for good - there's no recovery.

## 7. Test a deposit

1. Send `\u{1F4E5} Receive` (or `/deposit`) to get your wallet address
2. Go to https://faucet.circle.com, select Arc Testnet, send testnet USDC
   to that address
3. Send `\u{1F4B0} Balance` - it's a live on-chain check, so it should show
   up as soon as the faucet transaction confirms (no sweeping/delay step
   like the old version had)

## Stopping the bot

In the CMD window, press `Ctrl + C`.

## Still missing before this is real

See `PAYIT_DOCUMENTATION.md` - most importantly, real Paj Cash off-ramp
credentials/address, a Termii API key for SMS verification, and a verified
Arc DEX address if you want Swap working.
