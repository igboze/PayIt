const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
let solc;
let ganache;
try {
  solc = require('solc');
  ganache = require('ganache');
} catch {
  // dev dependencies not installed in this environment
}
const { JsonRpcProvider, Wallet, ContractFactory, parseUnits } = require('ethers');

if (!solc || !ganache) {
  test.skip('contract_invoice_settlement: solc or ganache devDependency not installed', () => {});
  return;
}

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
  const provider = new JsonRpcProvider(`http://127.0.0.1:${address.port}`, undefined, { staticNetwork: true });

  const signer0 = await provider.getSigner(0);
  const signer1 = await provider.getSigner(1);
  const signer2 = await provider.getSigner(2);

  const deployFeeRecipient = signer1.address;
  const deployPauser = signer0.address;
  const deployBlacklister = signer2.address;

  const factoryUSDC = new ContractFactory(compiledUSDC.abi, compiledUSDC.evm.bytecode.object, signer0);
  const usdc = await factoryUSDC.deploy({ gasLimit: 7_500_000n });
  await usdc.waitForDeployment();

  const factoryInvoice = new ContractFactory(compiledInvoice.abi, compiledInvoice.evm.bytecode.object, signer0);
  const contract = await factoryInvoice.deploy(usdc.target, deployFeeRecipient, deployPauser, deployBlacklister, { gasLimit: 7_500_000n });
  await contract.waitForDeployment();

  const initialMint = parseUnits('1000', 18);
  const mintTx0 = await usdc.mint(signer0.address, initialMint);
  await mintTx0.wait();
  const mintTx1 = await usdc.mint(signer1.address, initialMint);
  await mintTx1.wait();
  const mintTx2 = await usdc.mint(signer2.address, initialMint);
  await mintTx2.wait();

  return { provider, server, signer0, signer1, signer2, contract, usdc };
}

async function teardown(server) {
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    if (typeof server.close === 'function') {
      await server.close();
    }
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

    const tx1 = await contract.requestOwnershipTransfer(signer1Address);
    await tx1.wait();
    const pendingOwner = await contract.pendingOwner();
    assert.equal(pendingOwner, signer1Address);

    const contractAsNewOwner = contract.connect(signer1);
    const tx2 = await contractAsNewOwner.acceptOwnership();
    await tx2.wait();
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

    const pauseTx = await contractAsOwner.pause();
    await pauseTx.wait();
    const paused = await contract.paused();
    assert.equal(paused, true);

    await assert.rejects(
      async () => {
        const tx = await contract.settleInvoice(123, signer1Address, 100, parseUnits('0.01', 18), parseUnits('0.02', 18), parseUnits('0.1', 18));
        await tx.wait();
      },
      (err) => {
        const msg = String(err && (err.message || err.reason || err));
        return msg.includes('PausedError') || msg.includes('revert') || msg.includes('CALL_EXCEPTION') || err.code === 'CALL_EXCEPTION';
      }
    );

    const unpauseTx = await contractAsOwner.unpause();
    await unpauseTx.wait();
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
    const withdrawTx = await contractAsOwner.emergencyWithdraw(recipient, depositAmount);
    await withdrawTx.wait();
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

    const approveTx = await usdc.connect(signer0).approve(contract.target, amount);
    await approveTx.wait();

    const feeRecipientInitial = await usdc.balanceOf(feeRecipient);
    const recipientInitial = await usdc.balanceOf(recipient);

    const contractAsPayer = contract.connect(signer0);
    const settleTx = await contractAsPayer.settleInvoice(54, recipient, feeBps, minFee, maxFee, amount);
    await settleTx.wait();

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

    const blacklistTx = await blacklister.updateBlacklist(callerAddress, true);
    await blacklistTx.wait();

    const contractAsPayer = contract.connect(signer0);
    await assert.rejects(
      async () => {
        const tx = await contractAsPayer.settleInvoice(77, recipient, feeBps, minFee, maxFee, parseUnits('0.5', 18));
        await tx.wait();
      },
      (err) => {
        const msg = String(err && (err.message || err.reason || err));
        return msg.includes('Blacklisted') || msg.includes('revert') || msg.includes('CALL_EXCEPTION') || err.code === 'CALL_EXCEPTION';
      }
    );
  } finally {
    await teardown(server);
  }
});

