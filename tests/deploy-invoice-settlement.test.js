const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDeploymentConfig } = require('../scripts/deploy-invoice-settlement');

test('validateDeploymentConfig rejects unsupported chain IDs', () => {
  const result = validateDeploymentConfig({
    rpcUrl: 'https://rpc.testnet.arc.network',
    privateKey: '0x' + '11'.repeat(32),
    feeRecipient: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0x3600000000000000000000000000000000000000',
    chainId: 1,
    signerAddress: '0x2222222222222222222222222222222222222222',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Arc testnet deployment requires chain ID/i);
});

test('validateDeploymentConfig accepts Arc testnet settings', () => {
  const result = validateDeploymentConfig({
    rpcUrl: 'https://rpc.testnet.arc.network',
    privateKey: '0x' + '11'.repeat(32),
    feeRecipient: '0x1111111111111111111111111111111111111111',
    tokenAddress: '0x3600000000000000000000000000000000000000',
    chainId: 5042002,
    signerAddress: '0x2222222222222222222222222222222222222222',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
