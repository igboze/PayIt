const test = require('node:test');
const assert = require('node:assert/strict');
const ni = require('../src/near_intents');

test('isValidRecipient checks address shape per chain', () => {
  assert.equal(ni.isValidRecipient('base', '0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359'), true);
  assert.equal(ni.isValidRecipient('base', '0x123'), false);
  assert.equal(ni.isValidRecipient('sol', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), true);
  assert.equal(ni.isValidRecipient('sol', '0x0AC27C77C56f5176c37aE23BE3a42A130E3a9359'), false);
  assert.equal(ni.isValidRecipient('tron', 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm'), true);
  assert.equal(ni.isValidRecipient('near', 'alice.near'), true);
  assert.equal(ni.isValidRecipient('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), true);
  assert.equal(ni.isValidRecipient('eth', 'has space'), false);
});

test('toUnits / fromUnits round-trip token amounts', () => {
  assert.equal(ni.toUnits(12.345679, 6), '12345679');
  assert.equal(ni.toUnits(1, 18), '1000000000000000000');
  assert.equal(ni.fromUnits('12345679', 6), 12.345679);
});

test('live sends are off unless explicitly enabled', () => {
  const prev = process.env.NEAR_INTENTS_ENABLED;
  delete process.env.NEAR_INTENTS_ENABLED;
  assert.equal(ni.isEnabled(), false);
  process.env.NEAR_INTENTS_ENABLED = 'true';
  assert.equal(ni.isEnabled(), true);
  if (prev === undefined) delete process.env.NEAR_INTENTS_ENABLED; else process.env.NEAR_INTENTS_ENABLED = prev;
});
