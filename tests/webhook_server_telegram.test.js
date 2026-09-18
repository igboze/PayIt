const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const webhookServer = require("../src/webhook_server");

describe("Unified Webhook Server Suite", () => {
  it("routes /health and /webhook/telegram", async () => {
    let telegramWebhookCalled = false;
    const mockBot = {
      webhookCallback: (path) => (req, res) => {
        telegramWebhookCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    };

    const server = webhookServer.createWebhookServer({
      bot: mockBot,
      webhookPath: "/webhook/telegram",
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      // Test /health
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(healthRes.status, 200);
      const healthBody = await healthRes.json();
      assert.strictEqual(healthBody.status, "ok");

      // Test /webhook/telegram
      const tgRes = await fetch(`http://127.0.0.1:${port}/webhook/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 12345 }),
      });
      assert.strictEqual(tgRes.status, 200);
      assert.strictEqual(telegramWebhookCalled, true);
    } finally {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
