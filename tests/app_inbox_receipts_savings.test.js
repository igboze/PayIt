// In-app notification inbox, signed receipt links, payout details on transactions, and the
// savings rate recorded at the time of saving.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmpDb = path.join(os.tmpdir(), `app_inbox_receipts_${process.pid}_${Date.now()}.db`);
process.env.PAYIT_DB_PATH = tmpDb;
process.env.INVOICE_FORWARDING_SECRET = "inbox-receipts-test-secret-not-real-0000";
process.env.APP_JWT_SECRET = "inbox-receipts-test-jwt-secret-not-real-0123456789";
process.env.APP_RP_ID = "proxim.test";
process.env.APP_ORIGINS = "https://proxim.test";
process.env.APP_INTEGRITY_MODE = "log";

const { ethers } = require("ethers");
const db = require("../src/db");
const inbox = require("../src/app_api/inbox");
const tokens = require("../src/app_api/tokens");
const features = require("../src/app_api/features");
const routes = require("../src/app_api/routes");
const { notify } = require("../src/notify");

const TG = 880001;
let server;
let base;

test.before(async () => {
  const w = ethers.Wallet.createRandom();
  db.createUserWithWallet(TG, "inbox_user", w.address, w.privateKey, "4826");
  server = http.createServer((req, res) => routes.handleAppApiRequest(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  features.__setTestDeps({});
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
});

test("notify() writes to the in-app inbox; unread count and mark-read work", async () => {
  await notify(TG, { title: "Money received", html: "💸 <b>You received $5.00</b> from Ada.", data: { type: "transfer_received" } });
  inbox.addNotification(TG, { title: "Savings", body: "Moved $10 to savings", data: { type: "auto_earn_deposit" } });

  let list = inbox.listNotifications(TG);
  assert.equal(list.unread, 2);
  assert.equal(list.notifications[0].title, "Savings");
  assert.equal(list.notifications[1].body, "💸 You received $5.00 from Ada.", "HTML is stripped");
  assert.equal(list.notifications[1].kind, "transfer_received");

  inbox.markRead(TG, [list.notifications[0].id]);
  assert.equal(inbox.listNotifications(TG).unread, 1);
  inbox.markRead(TG);
  list = inbox.listNotifications(TG);
  assert.equal(list.unread, 0);
  assert.ok(list.notifications.every((n) => n.read));
  // Another user's inbox is separate.
  assert.equal(inbox.listNotifications(TG + 1).notifications.length, 0);
});

test("signed receipt links: valid, tampered and expired", () => {
  const { u, e, s } = tokens.signReceiptLink(TG, 42);
  assert.equal(tokens.verifyReceiptLink(u, 42, e, s), true);
  assert.equal(tokens.verifyReceiptLink(u, 43, e, s), false, "other transaction");
  assert.equal(tokens.verifyReceiptLink(String(TG + 1), 42, e, s), false, "other user");
  assert.equal(tokens.verifyReceiptLink(u, 42, e, s.slice(0, -2) + "xx"), false, "tampered signature");
  const old = tokens.signReceiptLink(TG, 42, -5);
  assert.equal(tokens.verifyReceiptLink(old.u, 42, old.e, old.s), false, "expired");
});

test("public receipt route serves the PNG as a download only with a valid link", async () => {
  const txId = Number(db.recordTransaction(TG, "offramp", "25000000000000000000", "submitted", "paj_order_rcpt_1", "personal", 18, "solana", "rent"));
  db.recordOfframpOrder({
    orderId: "paj_order_rcpt_1", telegramId: TG, accountType: "personal", accountNumber: "0123456742", bankCode: "000058",
    bankName: "GTBank", accountName: "ADA OKAFOR", amountUsdc: 25, fiatAmount: 38750, rate: 1550, rail: "solana",
    txHash: null, narration: "rent", senderName: null, status: "submitted",
  });

  let receiptArgs = null;
  features.__setTestDeps({
    receiptGenerator: {
      generateReceiptPNG: async (args) => {
        receiptArgs = args;
        const p = path.join(os.tmpdir(), `rcpt_${Date.now()}.png`);
        fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return p;
      },
    },
  });

  const { u, e, s } = tokens.signReceiptLink(TG, txId);
  const ok = await fetch(`${base}/api/app/v1/receipts/${txId}?u=${u}&e=${e}&s=${encodeURIComponent(s)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.match(ok.headers.get("content-disposition") || "", /^attachment; filename="proxim-receipt-\d+\.png"/);
  assert.equal(receiptArgs.recipientName, "ADA OKAFOR", "payout receipts name the account paid");
  assert.match(receiptArgs.recipientAddress, /GTBank · 0123456742/);

  const bad = await fetch(`${base}/api/app/v1/receipts/${txId}?u=${u}&e=${e}&s=nope`);
  assert.equal(bad.status, 403);
  const noSig = await fetch(`${base}/api/app/v1/receipts/${txId}`);
  assert.equal(noSig.status, 403);
});

test("savings overview shows the user's rate at the time of saving, and today's rate", async () => {
  const vault = "0xa8fd51b78370c7ca948566d7ba97d252bc325124";
  features.__setTestDeps({
    savings: {
      getYieldPools: async () => [{ name: "Dollar vault", symbol: "USDC", vaultAddress: vault, rawApy: 6.0, userApy: 5.4, payitApy: 0.6 }],
      calcAccruedYield: () => 0.12,
      PAYIT_FEE_FRACTION: 0.1,
    },
  });
  const auth = { telegramId: TG, user: db.getUser(TG) };

  // New-style position: the user's own rate is stored.
  db.openYieldPosition(TG, 100, { vaultAddress: vault, rawApy: 5.2, userApy: 4.68, payitApy: 0.52, project: "Morpho", symbol: "USDC" }, { accountType: "personal" });
  let res = await features.getSavingsOverview(auth, null);
  assert.equal(res.data.position.apyAtDeposit, 4.68);
  assert.equal(res.data.position.apy, 4.68);
  assert.equal(res.data.position.currentApy, 5.4);

  // Older position that only stored the vault's gross rate: show the user's share of it.
  db.db.prepare("UPDATE yield_positions SET user_apy = NULL, apy = 5.2 WHERE telegram_id = ?").run(TG);
  res = await features.getSavingsOverview(auth, null);
  assert.equal(res.data.position.apyAtDeposit, 4.68);
});

test("profile photo: re-encoded to a 320px JPEG, non-images rejected, delete works", async () => {
  const avatars = require("../src/app_api/avatars");
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 160, b: 90 } } }).png().toBuffer();
  const version = await avatars.saveAvatar(TG, `data:image/png;base64,${png.toString("base64")}`);
  assert.ok(version, "returns a version");
  const row = avatars.getAvatar(TG);
  assert.equal(row.mime, "image/jpeg");
  const meta = await sharp(Buffer.from(row.data)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 320);
  await assert.rejects(avatars.saveAvatar(TG, Buffer.from("not an image at all").toString("base64")), (e) => e.code === "invalid_image");
  await assert.rejects(avatars.saveAvatar(TG, ""), (e) => e.code === "invalid_image");
  assert.equal(avatars.deleteAvatar(TG), true);
  assert.equal(avatars.getAvatar(TG), null);
});

test("background bot alerts reach the app inbox; replies and notify() sends are not duplicated", async () => {
  const notifyMod = require("../src/notify");
  const sent = [];
  const middlewares = [];
  const fakeBot = {
    use: (fn) => middlewares.push(fn),
    telegram: {
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; },
    },
  };
  notifyMod.setNotifyBot(fakeBot);
  const before = inbox.listNotifications(TG).notifications.length;
  const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

  // 1) Background alert (no update in progress) -> mirrored.
  await fakeBot.telegram.sendMessage(TG, "✅ <b>Deposit received</b>\n₦50,000 is now in your balance.");
  await settle();
  let list = inbox.listNotifications(TG).notifications;
  assert.equal(list.length, before + 1);
  assert.equal(list[0].title, "Deposit received");
  assert.equal(list[0].body, "₦50,000 is now in your balance.");

  // 2) Reply while handling the user's own update -> not mirrored.
  await middlewares[0]({}, async () => { await fakeBot.telegram.sendMessage(TG, "Here is your menu"); });
  await settle();
  assert.equal(inbox.listNotifications(TG).notifications.length, before + 1);

  // 3) notify() -> exactly one inbox entry, and the Telegram copy is still sent.
  await notifyMod.notify(TG, { title: "Card charged", html: "💳 <b>Card charged</b> $4.00" });
  await settle();
  assert.equal(inbox.listNotifications(TG).notifications.length, before + 2);
  assert.ok(sent.some((m) => /Card charged/.test(m.text)));

  // 4) Group chats / unknown ids are ignored.
  await fakeBot.telegram.sendMessage(-100123, "Group announcement");
  await settle();
  assert.equal(inbox.listNotifications(-100123).notifications.length, 0);
});
