const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const solc = require('solc');
const ganache = require('ganache');
const { JsonRpcProvider, Wallet, ContractFactory, parseUnits } = require('ethers');

function compileContract(contractFileName) {
  const contractPath = path.join(__dirname, '..', 'contracts', contractFileName);
  const source = fs.readFileSync(contractPath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      [contractFileName]: { content: source }
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object']
        }
      }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === 'error');
    if (errors.length) {
      throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    }
  }
  return output.contracts[contractFileName];
}

function compileInvoiceSettlement() {
  return compileContract('InvoiceSettlement.sol').InvoiceSettlement;
}

function compileMockUSDC() {
  return compileContract('MockUSDC.sol').MockUSDC;
}

async function setup() {
  const compiledInvoice = compileInvoiceSettlement();
  const compiledUSDC = compileMockUSDC();
  const server = ganache.server({ wallet: { deterministic: true }, chain: { chainId: 1337 } });
  await server.listen(0);
  const address = server.address();
  const provider = new JsonRpcProvider(`http://127.0.0.1:${address.port}`);

  const privateKeys = [
    '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
    '0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1',
    '0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c'
  ];

  const signer0 = new Wallet(privateKeys[0], provider);
  const signer1 = new Wallet(privateKeys[1], provider);
  const signer2 = new Wallet(privateKeys[2], provider);

  const deployFeeRecipient = await signer1.getAddress();
  const deployPauser = await signer0.getAddress();
  const deployBlacklister = await signer2.getAddress();

  const factoryUSDC = new ContractFactory(compiledUSDC.abi, compiledUSDC.evm.bytecode.object, signer0);
  const usdc = await factoryUSDC.deploy({ gasLimit: 7_500_000n });
  await usdc.waitForDeployment();

  const factoryInvoice = new ContractFactory(compiledInvoice.abi, compiledInvoice.evm.bytecode.object, signer0);
  const contract = await factoryInvoice.deploy(usdc.target, deployFeeRecipient, deployPauser, deployBlacklister, { gasLimit: 7_500_000n });
  await contract.waitForDeployment();

  const initialMint = parseUnits('1000', 18);
  const mintTx0 = await usdc.mint(await signer0.getAddress(), initialMint);
  await mintTx0.wait();
  const mintTx1 = await usdc.mint(await signer1.getAddress(), initialMint);
  await mintTx1.wait();
  const mintTx2 = await usdc.mint(await signer2.getAddress(), initialMint);
  await mintTx2.wait();

  return { provider, server, signer0, signer1, signer2, contract, usdc };
}

async function mineOne(provider) {
  if (provider.send) {
    await provider.send('evm_mine', []);
  }
}

async function teardown(server) {
  if (server && typeof server.close === 'function') {
    await server.close();
  }
}

function normalizeError(err) {
  if (!err || !err.message) return err;
  return err.message || String(err);
}

test('contract supports ownership transfer', async () => {
  const { signer0, signer1, contract, server } = await setup();
  try {
    const signer1Address = await signer1.getAddress();

    await contract.requestOwnershipTransfer(signer1Address);
    const pendingOwner = await contract.pendingOwner();
    assert.equal(pendingOwner, signer1Address);

    const contractAsNewOwner = contract.connect(signer1);
    await contractAsNewOwner.acceptOwnership();
    const owner = await contract.owner();
    assert.equal(owner, signer1Address);
  } finally {
    await teardown(server);
  }
});

test('contract can pause and unpause settlement', async () => {
  const { signer0, signer1, contract, server } = await setup();
  try {
    const signer1Address = await signer1.getAddress();
    const contractAsOwner = contract.connect(signer0);

    await contractAsOwner.pause();
    const paused = await contract.paused();
    assert.equal(paused, true);

    await assert.rejects(
      contract.settleInvoice(123, signer1Address, 100, parseUnits('0.01', 18), parseUnits('0.02', 18), parseUnits('0.1', 18)),
      (err) => {
        return err.message.includes('PausedError') || err.message.includes('revert');
      }
    );

    await contractAsOwner.unpause();
    const unpaused = await contract.paused();
    assert.equal(unpaused, false);
  } finally {
    await teardown(server);
  }
});

test('emergency withdraw returns contract USDC balance to recipient', async () => {
  const { signer0, signer2, contract, usdc, server } = await setup();
  try {
    const recipient = await signer2.getAddress();
    const depositAmount = parseUnits('1', 18);
    const contractAsOwner = contract.connect(signer0);

    const approveTx = await usdc.connect(signer0).approve(contract.target, depositAmount);
    await approveTx.wait();

    const depositTx = await contractAsOwner.deposit(depositAmount);
    await depositTx.wait();

    const contractBalance = await usdc.balanceOf(contract.target);
    assert.equal(contractBalance.toString(), depositAmount.toString());

    const initialRecipientBalance = await usdc.balanceOf(recipient);
    await contractAsOwner.emergencyWithdraw(recipient, depositAmount);
    const finalRecipientBalance = await usdc.balanceOf(recipient);

    assert.equal(finalRecipientBalance - initialRecipientBalance, depositAmount);
  } finally {
    await teardown(server);
  }
});

test('settleInvoice sends fee and remainder when not paused', async () => {
  const { signer0, signer1, signer2, contract, usdc, server } = await setup();
  try {
    const recipient = await signer2.getAddress();
    const feeRecipient = await contract.feeRecipient();
    const amount = parseUnits('1', 18);
    const feeBps = 100;
    const minFee = parseUnits('0.01', 18);
    const maxFee = parseUnits('0.5', 18);

    await usdc.connect(signer0).approve(contract.target, amount);

    const feeRecipientInitial = await usdc.balanceOf(feeRecipient);
    const recipientInitial = await usdc.balanceOf(recipient);

    const contractAsPayer = contract.connect(signer0);
    await contractAsPayer.settleInvoice(54, recipient, feeBps, minFee, maxFee, amount);

    const feeRecipientFinal = await usdc.balanceOf(feeRecipient);
    const recipientFinal = await usdc.balanceOf(recipient);
    const expectedFee = amount * BigInt(feeBps) / 10000n;
    const fee = expectedFee < minFee ? minFee : expectedFee > maxFee ? maxFee : expectedFee;
    assert.equal(feeRecipientFinal - feeRecipientInitial, fee);
    assert.equal(recipientFinal - recipientInitial, amount - fee);
  } finally {
    await teardown(server);
  }
});

test('settleInvoice rejects blacklisted caller', async () => {
  const { signer0, signer1, signer2, contract, server } = await setup();
  try {
    const blacklister = contract.connect(signer2);
    const callerAddress = await signer0.getAddress();
    const recipient = await signer1.getAddress();
    const feeBps = 100;
    const minFee = parseUnits('0.01', 18);
    const maxFee = parseUnits('0.5', 18);

    await blacklister.updateBlacklist(callerAddress, true);

    const contractAsPayer = contract.connect(signer0);
    await assert.rejects(
      contractAsPayer.settleInvoice(77, recipient, feeBps, minFee, maxFee, parseUnits('0.5', 18)),
      (err) => err.message.includes('Blacklisted') || err.message.includes('revert')
    );
  } finally {
    await teardown(server);
  }
});
