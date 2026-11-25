#!/usr/bin/env node
// mobile/scripts/build-ota-bundle.js
// Packages an `expo export --platform android` directory into a single atomic,
// Expo Updates Protocol v1-compliant `.tar.gz` archive ready for GitHub Releases
// and Proxim's self-hosted Railway OTA server (/api/app/v1/ota/*).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function contentTypeForExt(ext) {
  switch (String(ext || "").toLowerCase().replace(/^\./, "")) {
    case "hbc":
    case "js":
    case "bundle":
      return "application/javascript";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "woff2":
      return "font/woff2";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function sha256Base64Url(buf) {
  return crypto.createHash("sha256").update(buf).digest("base64url");
}

function deterministicUuid(seed) {
  const bytes = Buffer.from(crypto.createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4 format
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Pure-Node POSIX ustar writer (zero dependencies, works identically on Windows & Linux)
function createTarHeader(entryName, byteLength) {
  if (Buffer.byteLength(entryName, "utf8") > 100) {
    throw new Error(`Tar entry name exceeds 100 bytes: ${entryName}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(`${byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii"); // size
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii"); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder spaces
  header.write("0", 156, 1, "ascii"); // regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function packTarGz(entries) {
  const chunks = [];
  for (const { name, data } of entries) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    chunks.push(createTarHeader(name, buf.length));
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // EOF marker (two 512-byte zero blocks)
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function buildOtaBundle({
  mobileDir = path.resolve(__dirname, ".."),
  distDir,
  outDir,
  platform = "android",
  commitSha = process.env.GITHUB_SHA || "local",
  createdAt = new Date().toISOString(),
} = {}) {
  const appJson = JSON.parse(fs.readFileSync(path.join(mobileDir, "app.json"), "utf8"));
  const expoCfg = appJson.expo || {};
  const runtimeVersion = String(expoCfg.runtimeVersion || "1");
  const appVersion = String(expoCfg.version || "1.0.0");

  const resolvedDist = path.resolve(mobileDir, distDir || ".ota-dist");
  const resolvedOut = path.resolve(mobileDir, outDir || ".ota-package");
  const metadataPath = path.join(resolvedDist, "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing metadata.json at ${metadataPath}. Run 'npx expo export --platform ${platform}' first.`);
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const platMeta = metadata?.fileMetadata?.[platform];
  if (!platMeta?.bundle) {
    throw new Error(`No ${platform} bundle found in ${metadataPath}`);
  }

  const tarEntries = [];
  const seenFiles = new Set();

  // 1. Launch asset (.hbc or .js bundle)
  const bundleRel = String(platMeta.bundle).replace(/\\/g, "/");
  const bundleFullPath = path.join(resolvedDist, ...bundleRel.split("/"));
  const bundleBuf = fs.readFileSync(bundleFullPath);
  const bundleBase = path.posix.basename(bundleRel);
  const bundleExt = path.posix.extname(bundleBase) || ".hbc";
  const bundleKey = bundleBase.slice(0, bundleBase.length - bundleExt.length).replace(/[^A-Za-z0-9._-]/g, "_");
  const bundleFlatName = `${bundleKey}${bundleExt}`;
  const launchAsset = {
    hash: sha256Base64Url(bundleBuf),
    key: bundleKey,
    contentType: "application/javascript",
    fileExtension: bundleExt,
    fileName: bundleFlatName,
  };
  tarEntries.push({ name: `files/${bundleFlatName}`, data: bundleBuf });
  seenFiles.add(bundleFlatName);

  // 2. Static assets (images, fonts)
  const assets = [];
  for (const a of platMeta.assets || []) {
    const rel = String(a.path || "").replace(/\\/g, "/");
    const full = path.join(resolvedDist, ...rel.split("/"));
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const key = path.posix.basename(rel).replace(/[^A-Za-z0-9._-]/g, "_");
    const ext = `.${String(a.ext || "bin").replace(/^\./, "").toLowerCase()}`;
    const flatName = `${key}${ext}`;
    const hash = sha256Base64Url(buf);
    assets.push({
      hash,
      key,
      contentType: contentTypeForExt(ext),
      fileExtension: ext,
      fileName: flatName,
    });
    if (!seenFiles.has(flatName)) {
      tarEntries.push({ name: `files/${flatName}`, data: buf });
      seenFiles.add(flatName);
    }
  }

  const shortCommit = String(commitSha || "local").slice(0, 12);
  const seed = [
    platform,
    runtimeVersion,
    launchAsset.hash,
    ...assets.map((a) => `${a.key}:${a.hash}`).sort(),
    shortCommit,
  ].join("|");
  const updateId = deterministicUuid(seed);

  const otaManifest = {
    schemaVersion: 1,
    platform,
    runtimeVersion,
    id: updateId,
    createdAt,
    commit: shortCommit,
    appVersion,
    launchAsset,
    assets,
    metadata: {
      commit: shortCommit,
      appVersion,
    },
    extra: {
      expoClient: {
        name: expoCfg.name || "Proxim",
        slug: expoCfg.slug || "proxim-mobile",
        version: appVersion,
        runtimeVersion,
        scheme: expoCfg.scheme || "proxim",
        extra: expoCfg.extra || {},
      },
    },
  };

  tarEntries.unshift({
    name: "ota-manifest.json",
    data: Buffer.from(JSON.stringify(otaManifest, null, 2), "utf8"),
  });

  fs.mkdirSync(resolvedOut, { recursive: true });
  const archiveName = `ota-${platform}-rv-${runtimeVersion}.tar.gz`;
  const archivePath = path.join(resolvedOut, archiveName);
  const gzBuf = packTarGz(tarEntries);
  fs.writeFileSync(archivePath, gzBuf);

  const metaOutPath = path.join(resolvedOut, "ota-release-info.json");
  const releaseInfo = {
    tag: `ota-${platform}-rv-${runtimeVersion}`,
    archiveName,
    archivePath,
    archiveBytes: gzBuf.length,
    platform,
    runtimeVersion,
    updateId,
    appVersion,
    commit: shortCommit,
    createdAt,
    assetCount: assets.length,
  };
  fs.writeFileSync(metaOutPath, JSON.stringify(releaseInfo, null, 2), "utf8");
  return releaseInfo;
}

if (require.main === module) {
  const distDir = process.argv[2] || ".ota-dist";
  const outDir = process.argv[3] || ".ota-package";
  const platform = process.argv[4] || "android";
  const info = buildOtaBundle({ distDir, outDir, platform });
  console.log(JSON.stringify(info, null, 2));
}

module.exports = { buildOtaBundle, packTarGz, sha256Base64Url, deterministicUuid };
