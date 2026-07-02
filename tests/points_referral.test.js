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
