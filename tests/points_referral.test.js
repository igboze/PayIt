const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function loadDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payit-points-'));
  const dbPath = path.join(dir, 'payit.db');
  process.env.PAYIT_DB_PATH = dbPath;
  delete require.cache[require.resolve('../src/db')];
  return require('../src/db');
}

test('awardPoints notifies the user and referral bonus recipient', () => {
  const db = loadDb();
  const notifications = [];

  const referrer = db.createUserWithWallet(2001, 'referrer', '0xref', 'privref', '1111');
  const referred = db.createUserWithWallet(2002, 'referred', '0xnew', 'privnew', '2222', null, null, referrer.telegram_id);

  db.awardPoints(referred.telegram_id, 4, 'sendout', 'test send', {
    notify: (event) => notifications.push(event),
  });

  assert.equal(db.getPointsBalance(referred.telegram_id), 4);
  assert.equal(db.getPointsBalance(referrer.telegram_id), 20);
  assert.deepEqual(
    notifications.map((event) => event.action),
    ['referral_bonus', 'sendout']
  );
  assert.equal(notifications[0].telegramId, referrer.telegram_id);
});

test('getUserByReferralCode handles direct, case-insensitive, and numeric fallbacks', () => {
  const db = loadDb();
  const user = db.createUserWithWallet(3001, 'alice', '0xaaa', 'privaaa', '1234');

  // Direct match
  const matchDirect = db.getUserByReferralCode('ref3001');
  assert.ok(matchDirect);
  assert.equal(matchDirect.telegram_id, 3001);

  // Case-insensitive match
  const matchCase = db.getUserByReferralCode('REF3001');
  assert.ok(matchCase);
  assert.equal(matchCase.telegram_id, 3001);

  // Numeric fallback match
  const matchNum = db.getUserByReferralCode('3001');
  assert.ok(matchNum);
  assert.equal(matchNum.telegram_id, 3001);

  // Non-existent
  assert.equal(db.getUserByReferralCode('ref999999999'), null);
});

test('referral bonus is awarded only once on first point', () => {
  const db = loadDb();
  const referrer = db.createUserWithWallet(4001, 'bob', '0xbob', 'privbob', '1111');
  const referred = db.createUserWithWallet(4002, 'charlie', '0xcha', 'privcha', '2222', null, null, referrer.telegram_id);

  // First point transaction -> awards 20 pts to referrer
  db.awardPoints(referred.telegram_id, 5, 'cashout', 'first tx');
  assert.equal(db.getPointsBalance(referrer.telegram_id), 20);
  assert.equal(db.getPointsBalance(referred.telegram_id), 5);

  // Second point transaction -> does NOT award referral bonus again
  db.awardPoints(referred.telegram_id, 10, 'invoice', 'second tx');
  assert.equal(db.getPointsBalance(referrer.telegram_id), 20); // still 20
  assert.equal(db.getPointsBalance(referred.telegram_id), 15);
});
