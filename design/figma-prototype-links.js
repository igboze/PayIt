// Proxim Mobile App — Dark Premium: prototype links
// File: https://www.figma.com/design/xfRGHPeABiIK5jwvS5RfWB
//
// Links every screen (buttons, list rows, quick actions, back arrows, tab bars),
// adds timed transitions for the loading screens, and creates 4 prototype flows.
// Safe to run more than once: each run replaces the same reactions.
//
// How to run (any one of these):
//   - Ask Claude to run it again once the Figma MCP limit resets or the plan is upgraded.
//   - In Figma desktop, open the file, run the "Scripter" community plugin, paste this
//     whole file and press Run.

const page = await figma.getNodeByIdAsync('0:1');
await figma.setCurrentPageAsync(page);

const ID = {
  welcome: '4:3', verify: '4:26', passkey: '4:53', link: '4:103',
  home: '5:55', add: '5:168', payout: '5:223', approve: '5:265', receipt: '5:306',
  depChoose: '6:162', depAddr: '6:217', converting: '6:268', homeLoading: '6:304',
  sending: '6:373', failed: '6:411', newUser: '6:442',
  accounts: '7:247', cards: '7:326', bills: '7:411', savings: '7:486', security: '7:541',
};
const scr = {};
for (const [k, id] of Object.entries(ID)) scr[k] = await figma.getNodeByIdAsync(id);

const nav = (dest, type = 'SMART_ANIMATE', dur = 0.3) => ({
  type: 'NODE', destinationId: ID[dest], navigation: 'NAVIGATE',
  transition: { type, easing: { type: 'EASE_OUT' }, duration: dur }, resetScrollPosition: true,
});
const BACK = { type: 'BACK' };
const linked = [];
const missing = [];
async function click(node, action, label) {
  if (!node) { missing.push(label); return; }
  await node.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [action] }]);
  linked.push(label);
}
async function after(screen, seconds, action, label) {
  await screen.setReactionsAsync([{ trigger: { type: 'AFTER_TIMEOUT', timeout: seconds }, actions: [action] }]);
  linked.push(label);
}
const prop = (n, k) => (n.type === 'INSTANCE' && n.componentProperties && n.componentProperties[k] ? n.componentProperties[k].value : null);
const btn = (s, l) => s.findAll((n) => prop(n, 'Label#2:0') === l)[0];
const qa = (s, l) => s.findAll((n) => prop(n, 'Label#2:8') === l)[0];
const row = (s, t) => s.findAll((n) => prop(n, 'Title#2:4') === t)[0];
const back = (s) => { const h = s.findAll((n) => n.type === 'INSTANCE' && n.name === 'Header')[0]; return h && h.findOne((n) => n.name === 'Back'); };
const tab = (s, name) => { const tb = s.findAll((n) => n.type === 'INSTANCE' && n.name === 'TabBar')[0]; return tb && tb.findOne((n) => n.name === name && n.type === 'FRAME'); };

// Onboarding
await click(btn(scr.welcome, 'Continue'), nav('verify'), 'welcome → verify');
await click(btn(scr.welcome, 'I already use Proxim on Telegram'), nav('link'), 'welcome → link');
await click(btn(scr.welcome, 'Sign in with passkey'), nav('homeLoading', 'DISSOLVE'), 'welcome → home loading');
await click(btn(scr.verify, 'Verify'), nav('passkey'), 'verify → passkey');
await click(back(scr.verify), BACK, 'verify back');
await click(btn(scr.passkey, 'Create passkey'), nav('newUser', 'DISSOLVE'), 'passkey → new user');
await click(back(scr.passkey), BACK, 'passkey back');
await click(btn(scr.link, 'Link account'), nav('homeLoading', 'DISSOLVE'), 'link → home loading');
await click(back(scr.link), BACK, 'link back');

// Loading → Home
await after(scr.homeLoading, 1.2, nav('home', 'DISSOLVE', 0.4), 'home loading ⏱ → home');

// Home
await click(qa(scr.home, 'Add money'), nav('add'), 'home → add money');
await click(qa(scr.home, 'Send'), nav('payout'), 'home → send');
await click(qa(scr.home, 'Bills'), nav('bills'), 'home → bills');
await click(qa(scr.home, 'Cards'), nav('cards'), 'home → cards');
await click(scr.home.findOne((n) => n.name === 'SavingsPromo'), nav('savings'), 'home → savings');
await click(row(scr.home, 'Ada Okafor'), nav('receipt'), 'home → receipt');

// Tab bars
const tabDest = { Home: 'home', Accounts: 'accounts', Cards: 'cards', Profile: 'security' };
const tabsOn = {
  home: ['Accounts', 'Cards', 'Profile'], newUser: ['Accounts', 'Cards', 'Profile'],
  accounts: ['Home', 'Cards', 'Profile'], cards: ['Home', 'Accounts', 'Profile'], security: ['Home', 'Accounts', 'Cards'],
};
for (const [k, names] of Object.entries(tabsOn)) {
  for (const nm of names) await click(tab(scr[k], nm), nav(tabDest[nm], 'DISSOLVE', 0.2), `${k} tab ${nm}`);
}

// Add money
await click(back(scr.add), BACK, 'add money back');
await click(row(scr.add, 'Crypto'), nav('depChoose'), 'add money → crypto deposit');
await click(row(scr.add, 'Your GBP or USD account'), nav('accounts'), 'add money → accounts');
await click(btn(scr.add, 'Get account to pay into'), nav('home', 'DISSOLVE'), 'add money → home');

// Send flow
await click(back(scr.payout), BACK, 'send back');
await click(btn(scr.payout, 'Review and approve'), nav('approve', 'DISSOLVE', 0.25), 'send → approve');
await click(btn(scr.approve, 'Approve with Face ID'), nav('sending', 'DISSOLVE'), 'approve → sending');
await click(btn(scr.approve, 'Cancel'), BACK, 'approve cancel');
await after(scr.sending, 2.5, nav('receipt', 'DISSOLVE', 0.4), 'sending ⏱ → receipt');
await click(btn(scr.sending, 'Done'), nav('home', 'DISSOLVE'), 'sending → home');
await click(back(scr.receipt), nav('home'), 'receipt back → home');

// Failed transfer
await click(btn(scr.failed, 'Try again'), nav('payout'), 'failed → send');
await click(btn(scr.failed, 'Check recipient details'), nav('payout'), 'failed → send (recipient)');
await click(back(scr.failed), nav('home'), 'failed back → home');

// Crypto deposit (NEAR Intents)
await click(back(scr.depChoose), BACK, 'deposit back');
await click(btn(scr.depChoose, 'Get deposit address'), nav('depAddr'), 'deposit → address');
await click(back(scr.depAddr), BACK, 'address back');
await after(scr.depAddr, 3, nav('converting', 'DISSOLVE', 0.4), 'address ⏱ → converting');
await click(btn(scr.converting, 'Back to home'), nav('home', 'DISSOLVE'), 'converting → home');
await click(back(scr.converting), nav('home'), 'converting back → home');

// New user, Bills, Savings
await click(btn(scr.newUser, 'Add your first money'), nav('add'), 'new user → add money');
await click(back(scr.bills), BACK, 'bills back');
await click(back(scr.savings), BACK, 'savings back');

// Flows (Present → choose a flow)
page.flowStartingPoints = [
  { nodeId: ID.welcome, name: '1 · New user onboarding' },
  { nodeId: ID.homeLoading, name: '2 · Returning user' },
  { nodeId: ID.depChoose, name: '3 · Crypto deposit (NEAR Intents)' },
  { nodeId: ID.failed, name: '4 · Failed transfer' },
];

const result = { linked: linked.length, missing, flows: page.flowStartingPoints.map((f) => f.name) };
if (typeof print === 'function') print(result); else console.log(result);
