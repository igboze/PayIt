// tests/app_api_ota.test.js
// End-to-end tests for self-hosted Expo Updates Protocol v1 (OTA mobile updates):
//   - Packaging via mobile/scripts/build-ota-bundle.js into a POSIX .tar.gz
//   - Serving GET /api/app/v1/ota/manifest with Expo-Protocol-Version: 1 & base64url SHA-256 hashes
//   - Downloading launchAsset & static assets via GET /api/app/v1/ota/assets/... and verifying hashes
//   - 204 No Content when Expo-Current-Update-ID matches latest or no release exists
//   - POST /api/app/v1/ota/refresh & GET /api/app/v1/ota/status

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "proxim_ota_test_"));
process.env.PAYIT_DB_PATH = path.join(tmpBase, "test.db");
process.env.APP_JWT_SECRET = "ota-test-jwt-secret-not-real-0123456789";
process.env.APP_RP_ID = "proxim.test";
process.env.APP_ORIGINS = "https://proxim.test";
process.env.APP_OTA_CACHE_DIR = path.join(tmpBase, "ota-cache");
delete process.env.APP_PUBLIC_BASE_URL;
delete process.env.PUBLIC_BASE_URL;

const routes = require("../src/app_api/routes");
const ota = require("../src/app_api/ota");
const { buildOtaBundle, sha256Base64Url } = require("../mobile/scripts/build-ota-bundle");

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => routes.handleAppApiRequest(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  ota.__setTestFetcher(null);
  server?.close();
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
});

test("OTA packager + Expo Updates v1 manifest, asset hash verification, 204 up-to-date, and refresh", async () => {
  // 1. Build a mock expo export directory and package it with the real build-ota-bundle.js
  const distDir = path.join(tmpBase, "dist");
  const outDir = path.join(tmpBase, "out");
  fs.mkdirSync(path.join(distDir, "_expo", "static", "js", "android"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });

  const hbcBytes = Buffer.from("HERMES-MOCK-BYTECODE-V1-PROXIM-OTA-TEST");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  fs.writeFileSync(path.join(distDir, "_expo", "static", "js", "android", "index-deadbeef1234.hbc"), hbcBytes);
  fs.writeFileSync(path.join(distDir, "assets", "228c794ead8f8e5fe2d1524e4a8000d7"), pngBytes);
  fs.writeFileSync(
    path.join(distDir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        android: {
          bundle: "_expo/static/js/android/index-deadbeef1234.hbc",
          assets: [{ path: "assets\\228c794ead8f8e5fe2d1524e4a8000d7", ext: "png" }],
        },
      },
    })
  );

  const info = buildOtaBundle({ distDir, outDir, platform: "android", commitSha: "abc123456789" });
  const archiveBuf = fs.readFileSync(info.archivePath);
  assert.ok(archiveBuf.length > 50);
  assert.match(info.updateId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  let published = false;
  ota.__setTestFetcher(async (req) => {
    if (!published) return { notFound: true };
    if (req.kind === "release") {
      if (req.etag === '"etag-v1"') return { notModified: true, etag: '"etag-v1"' };
      return {
        etag: '"etag-v1"',
        assetKey: "asset-1:2026-11-25T17:00:00Z",
        downloadUrl: "https://example.invalid/ota-android-rv-1.tar.gz",
      };
    }
    return archiveBuf;
  });

  // 2. Before any release exists -> 204 No Content with expo-protocol-version: 1
  const emptyRes = await fetch(`${base}/api/app/v1/ota/manifest`, {
    headers: { "Expo-Platform": "android", "Expo-Runtime-Version": "1", "Expo-Protocol-Version": "1" },
  });
  assert.equal(emptyRes.status, 204);
  assert.equal(emptyRes.headers.get("expo-protocol-version"), "1");
  assert.equal(emptyRes.headers.get("content-type"), null);

  // 3. Publish release & call /ota/refresh
  published = true;
  const refreshRes = await fetch(`${base}/api/app/v1/ota/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "android", runtimeVersion: "1" }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshJson = await refreshRes.json();
  assert.equal(refreshJson.available, true);
  assert.equal(refreshJson.updateId, info.updateId);

  // 4. Fetch Expo Updates v1 manifest
  const manRes = await fetch(`${base}/api/app/v1/ota/manifest`, {
    headers: {
      "Expo-Platform": "android",
      "Expo-Runtime-Version": "1",
      "Expo-Protocol-Version": "1",
      "X-Forwarded-Proto": "http",
    },
  });
  assert.equal(manRes.status, 200);
  assert.equal(manRes.headers.get("expo-protocol-version"), "1");
  assert.equal(manRes.headers.get("expo-sfv-version"), "0");
  assert.match(manRes.headers.get("content-type"), /application\/expo\+json/);

  const manifest = await manRes.json();
  assert.equal(manifest.id, info.updateId);
  assert.equal(manifest.runtimeVersion, "1");
  assert.equal(manifest.launchAsset.hash, sha256Base64Url(hbcBytes));
  assert.equal(manifest.launchAsset.contentType, "application/javascript");
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].key, "228c794ead8f8e5fe2d1524e4a8000d7");
  assert.equal(manifest.assets[0].fileExtension, ".png");
  assert.equal(manifest.assets[0].hash, sha256Base64Url(pngBytes));

  // 5. Download both launchAsset and png asset and verify exact base64url SHA-256 hash
  const dlBundle = await fetch(manifest.launchAsset.url);
  assert.equal(dlBundle.status, 200);
  assert.match(dlBundle.headers.get("cache-control"), /immutable/);
  const dlBundleBuf = Buffer.from(await dlBundle.arrayBuffer());
  assert.equal(crypto.createHash("sha256").update(dlBundleBuf).digest("base64url"), manifest.launchAsset.hash);

  const dlPng = await fetch(manifest.assets[0].url);
  assert.equal(dlPng.status, 200);
  assert.equal(dlPng.headers.get("content-type"), "image/png");
  const dlPngBuf = Buffer.from(await dlPng.arrayBuffer());
  assert.equal(crypto.createHash("sha256").update(dlPngBuf).digest("base64url"), manifest.assets[0].hash);

  // 6. Client already on current updateId -> 204 No Content
  const upToDateRes = await fetch(`${base}/api/app/v1/ota/manifest`, {
    headers: {
      "Expo-Platform": "android",
      "Expo-Runtime-Version": "1",
      "Expo-Current-Update-ID": info.updateId,
    },
  });
  assert.equal(upToDateRes.status, 204);
  assert.equal(upToDateRes.headers.get("expo-protocol-version"), "1");

  // 7. Diagnostic status endpoint
  const statusRes = await fetch(`${base}/api/app/v1/ota/status?platform=android&runtimeVersion=1`);
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.available, true);
  assert.equal(statusJson.updateId, info.updateId);
  assert.equal(statusJson.assetCount, 1);
});
