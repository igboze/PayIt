// scripts/serve_terminal.js
// Boots the RaceAlpha Web Terminal & API server locally on port 3000

require("dotenv").config();
const { startWebhookServer } = require("../src/webhook_server");

const PORT = process.env.PORT || 3000;
const server = startWebhookServer({ port: PORT });

console.log(`\n======================================================`);
console.log(`🏎️  RaceAlpha Web Terminal is LIVE!`);
console.log(`📡 Localhost URL: http://localhost:${PORT}`);
console.log(`📊 Terminal URL:  http://localhost:${PORT}/terminal`);
console.log(`⚡ API Endpoint:  http://localhost:${PORT}/api/v1/race/traders`);
console.log(`======================================================\n`);
