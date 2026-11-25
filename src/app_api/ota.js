// src/app_api/ota.js
// Self-hosted Expo Updates Protocol v1 server for Proxim Mobile.
// Pulls atomic signed-by-SHA256 OTA tarballs published by GitHub Actions to GitHub Releases
// (tag: ota-<platform>-rv-<runtimeVersion>, asset: ota-<platform>-rv-<runtimeVersion>.tar.gz),
// extracts into ephemeral /tmp/proxim-ota (zero /data volume usage), and serves:
//   - GET  /api/app/v1/ota/manifest
//   - GET  /api/app/v1/ota/assets/:platform/:runtimeVersion/:updateId/:fileName
//   - GET  /api/app/v1/ota/status
//   - POST /api/app/v1/ota/refresh

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const DEFAULT_REPO = "igboze/PayIt";
const CACHE_TTL_MS = 60 * 1000; // Revalidate against GitHub API at most once per minute (with ETag -> 0 quota on 304)
const MISSING_TTL_MS = 30 * 1000;
const MAX_TAR_BYTES = 50 * 1024 * 1024;
const MAX_TAR_FILES = 500;

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-key in-memory cache: key = `${platform}:${runtimeVersion}`
const stateCache = new Map();
const inFlight = new Map();

let testFetcher = null;
function __setTestFetcher(fn) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTestFetcher cannot be used in production.");
  }
  testFetcher = fn || null;
  stateCache.clear();
  inFlight.clear();
}

function getRepo() {
  const configured = String(process.env.APP_OTA_GITHUB_REPO || DEFAULT_REPO).trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured) ? configured : DEFAULT_REPO;
}

function getCacheRoot() {
  return process.env.APP_OTA_CACHE_DIR || path.join(os.tmpdir(), "proxim-ota");
}

function getPublicBaseUrl(req) {
  const envBase = (process.env.APP_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = String(req?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "https://payit-production.up.railway.app";
}

function contentTypeForFile(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  switch (ext) {
    case ".hbc":
    case ".js":
    case ".bundle":
      return "application/javascript";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

// Pure-Node POSIX ustar .tar.gz extractor (zero shell exec, path-traversal safe)
function extractTarGzToDir(tarGzBuf, destDir) {
  const tarBuf = zlib.gunzipSync(tarGzBuf);
  if (tarBuf.length > MAX_TAR_BYTES) {
    throw new Error("OTA archive exceeds maximum allowed size.");
  }
  fs.mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let fileCount = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two zero blocks signal end of archive
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = (rawPrefix ? `${rawPrefix}/${rawName}` : rawName).replace(/^\.\//, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const fileSize = parseInt(sizeStr || "0", 8);
    const typeFlag = String.fromCharCode(header[156] || 48);

    offset += 512;
    if (!Number.isFinite(fileSize) || fileSize < 0 || offset + fileSize > tarBuf.length) {
      throw new Error("Corrupted OTA tar archive.");
    }

    const data = tarBuf.subarray(offset, offset + fileSize);
    offset += Math.ceil(fileSize / 512) * 512;

    // Only extract regular files ('0' or '\0')
    if (typeFlag !== "0" && typeFlag !== "\0") continue;
    if (!fullName || fullName.startsWith("/") || fullName.includes("..") || fullName.includes("\\")) {
      throw new Error(`Unsafe path in OTA archive: ${fullName}`);
    }
    const parts = fullName.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || !SAFE_FILE_RE.test(p))) {
      throw new Error(`Invalid filename in OTA archive: ${fullName}`);
    }

    fileCount += 1;
    if (fileCount > MAX_TAR_FILES) {
      throw new Error("OTA archive contains too many files.");
    }

    const outPath = path.join(destDir, ...parts);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

async function fetchGitHubReleaseMetadata(platform, runtimeVersion, etag) {
  if (testFetcher) {
    return testFetcher({ kind: "release", platform, runtimeVersion, etag });
  }
  const repo = getRepo();
  const tag = `ota-${platform}-rv-${runtimeVersion}`;
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Proxim-OTA-Server/1.0",
  };
  if (etag) headers["If-None-Match"] = etag;
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (res.status === 304) return { notModified: true, etag };
  if (res.status === 404) return { notFound: true };
  if (!res.ok) {
    throw new Error(`GitHub release lookup failed (${res.status})`);
  }
  const release = await res.json();
  const assetName = `ota-${platform}-rv-${runtimeVersion}.tar.gz`;
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset || !asset.browser_download_url) {
    return { notFound: true };
  }
  return {
    etag: res.headers.get("etag") || null,
    assetKey: `${asset.id}:${asset.updated_at || release.published_at || ""}`,
    downloadUrl: asset.browser_download_url,
  };
}

async function downloadTarGz(downloadUrl, platform, runtimeVersion) {
  if (testFetcher) {
    return testFetcher({ kind: "download", downloadUrl, platform, runtimeVersion });
  }
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "Proxim-OTA-Server/1.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(downloadUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`OTA tarball download failed (${res.status})`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function pruneOldDirs(parentDir, keepDirName) {
  try {
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry !== keepDirName) {
        fs.rmSync(path.join(parentDir, entry), { recursive: true, force: true });
      }
    }
  } catch (_) {}
}

async function syncRelease(platform, runtimeVersion, { force = false } = {}) {
  const cacheKey = `${platform}:${runtimeVersion}`;
  const existing = stateCache.get(cacheKey);
  const now = Date.now();
  if (!force && existing) {
    const ttl = existing.manifest ? CACHE_TTL_MS : MISSING_TTL_MS;
    if (now - existing.checkedAt < ttl) {
      return existing;
    }
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const work = (async () => {
    try {
      const meta = await fetchGitHubReleaseMetadata(platform, runtimeVersion, force ? null : existing?.etag || null);
      if (meta?.notModified && existing?.manifest) {
        existing.checkedAt = Date.now();
        return existing;
      }
      if (meta?.notFound) {
        const empty = { manifest: null, dir: null, assetKey: null, etag: null, checkedAt: Date.now() };
        stateCache.set(cacheKey, empty);
        return empty;
      }
      if (existing?.manifest && existing.assetKey === meta.assetKey && existing.dir && fs.existsSync(existing.dir)) {
        existing.etag = meta.etag || existing.etag;
        existing.checkedAt = Date.now();
        return existing;
      }

      const tarGzBuf = await downloadTarGz(meta.downloadUrl, platform, runtimeVersion);
      const tagRoot = path.join(getCacheRoot(), `${platform}-rv-${runtimeVersion}`);
      const stagingName = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stagingDir = path.join(tagRoot, stagingName);
      extractTarGzToDir(tarGzBuf, stagingDir);

      const manifestPath = path.join(stagingDir, "ota-manifest.json");
      if (!fs.existsSync(manifestPath)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw new Error("OTA archive missing ota-manifest.json");
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!manifest?.id || !SAFE_UUID_RE.test(manifest.id) || !manifest?.launchAsset?.fileName) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw new Error("Invalid ota-manifest.json in OTA archive");
      }

      const finalName = manifest.id.toLowerCase();
      const finalDir = path.join(tagRoot, finalName);
      if (fs.existsSync(finalDir)) {
        fs.rmSync(finalDir, { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, finalDir);
      pruneOldDirs(tagRoot, finalName);

      const next = {
        manifest,
        dir: finalDir,
        assetKey: meta.assetKey,
        etag: meta.etag || null,
        checkedAt: Date.now(),
      };
      stateCache.set(cacheKey, next);
      return next;
    } catch (err) {
      console.warn(`[app_api:ota] sync warning (${cacheKey}): ${err.message}`);
      if (existing?.manifest) {
        existing.checkedAt = Date.now();
        return existing;
      }
      return { manifest: null, dir: null, assetKey: null, etag: null, checkedAt: Date.now(), error: err.message };
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, work);
  return work;
}

function parsePlatform(raw) {
  const p = String(raw || "android").trim().toLowerCase();
  if (p !== "android" && p !== "ios") return null;
  return p;
}

function parseRuntimeVersion(raw) {
  const rv = String(raw || "").trim();
  if (!rv || !SAFE_TOKEN_RE.test(rv)) return null;
  return rv;
}

// GET /api/app/v1/ota/manifest
async function getManifest(req, url) {
  const platform = parsePlatform(req.headers["expo-platform"] || url.searchParams.get("platform") || "android");
  const runtimeVersion = parseRuntimeVersion(req.headers["expo-runtime-version"] || url.searchParams.get("runtimeVersion"));

  if (!platform) {
    return { status: 400, data: { error: { code: "invalid_platform", message: "Unsupported platform." } } };
  }
  if (!runtimeVersion) {
    return { status: 400, data: { error: { code: "missing_runtime_version", message: "Missing Expo-Runtime-Version header." } } };
  }

  const release = await syncRelease(platform, runtimeVersion);
  const currentUpdateId = String(req.headers["expo-current-update-id"] || "").trim().toLowerCase();
  const noOpHeaders = {
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "Cache-Control": "no-store",
  };

  if (!release?.manifest) {
    return { status: 204, raw: Buffer.alloc(0), headers: noOpHeaders };
  }

  if (currentUpdateId && currentUpdateId === String(release.manifest.id).toLowerCase()) {
    return { status: 204, raw: Buffer.alloc(0), headers: noOpHeaders };
  }

  const m = release.manifest;
  const baseUrl = getPublicBaseUrl(req);
  const assetUrl = (fileName) =>
    `${baseUrl}/api/app/v1/ota/assets/${encodeURIComponent(platform)}/${encodeURIComponent(runtimeVersion)}/${encodeURIComponent(m.id)}/${encodeURIComponent(fileName)}`;

  const manifestPayload = {
    id: m.id,
    createdAt: m.createdAt,
    runtimeVersion: String(m.runtimeVersion || runtimeVersion),
    launchAsset: {
      hash: m.launchAsset.hash,
      key: m.launchAsset.key,
      contentType: m.launchAsset.contentType || "application/javascript",
      ...(m.launchAsset.fileExtension ? { fileExtension: m.launchAsset.fileExtension } : {}),
      url: assetUrl(m.launchAsset.fileName),
    },
    assets: (m.assets || []).map((a) => ({
      hash: a.hash,
      key: a.key,
      contentType: a.contentType || contentTypeForFile(a.fileName),
      fileExtension: a.fileExtension,
      url: assetUrl(a.fileName),
    })),
    metadata: m.metadata || {},
    extra: m.extra || {},
  };

  return {
    status: 200,
    contentType: "application/expo+json; charset=utf-8",
    headers: {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "Cache-Control": "no-store",
    },
    raw: Buffer.from(JSON.stringify(manifestPayload), "utf8"),
  };
}

// GET /api/app/v1/ota/assets/:platform/:runtimeVersion/:updateId/:fileName
async function getAsset(_req, _url, match) {
  const platform = parsePlatform(match?.[1]);
  const runtimeVersion = parseRuntimeVersion(match?.[2]);
  const updateId = String(match?.[3] || "").trim().toLowerCase();
  const fileName = String(match?.[4] || "").trim();

  if (!platform || !runtimeVersion || !SAFE_UUID_RE.test(updateId) || !SAFE_FILE_RE.test(fileName)) {
    return { status: 400, data: { error: { code: "invalid_asset", message: "Invalid OTA asset path." } } };
  }

  let release = await syncRelease(platform, runtimeVersion);
  const candidatePath = path.join(getCacheRoot(), `${platform}-rv-${runtimeVersion}`, updateId, "files", fileName);
  let filePath = fs.existsSync(candidatePath) ? candidatePath : null;

  if (!filePath && release?.dir) {
    const activePath = path.join(release.dir, "files", fileName);
    if (fs.existsSync(activePath)) filePath = activePath;
  }
  if (!filePath) {
    // Force one sync in case a brand-new release just dropped
    release = await syncRelease(platform, runtimeVersion, { force: true });
    if (release?.dir) {
      const refreshedPath = path.join(release.dir, "files", fileName);
      if (fs.existsSync(refreshedPath)) filePath = refreshedPath;
    }
  }
  if (!filePath) {
    return { status: 404, data: { error: { code: "not_found", message: "OTA asset not found." } } };
  }

  const raw = fs.readFileSync(filePath);
  return {
    status: 200,
    contentType: contentTypeForFile(fileName),
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(raw.length),
    },
    raw,
  };
}

// GET /api/app/v1/ota/status
async function getStatus(_req, url) {
  const platform = parsePlatform(url.searchParams.get("platform") || "android") || "android";
  const runtimeVersion = parseRuntimeVersion(url.searchParams.get("runtimeVersion") || "1") || "1";
  const release = await syncRelease(platform, runtimeVersion);
  return {
    status: 200,
    data: {
      platform,
      runtimeVersion,
      repo: getRepo(),
      available: Boolean(release?.manifest),
      updateId: release?.manifest?.id || null,
      appVersion: release?.manifest?.appVersion || null,
      commit: release?.manifest?.commit || null,
      createdAt: release?.manifest?.createdAt || null,
      assetCount: release?.manifest?.assets?.length || 0,
    },
  };
}

// POST /api/app/v1/ota/refresh
async function refreshOta(_req, body) {
  const platform = parsePlatform(body?.platform || "android") || "android";
  const runtimeVersion = parseRuntimeVersion(body?.runtimeVersion || "1") || "1";
  const release = await syncRelease(platform, runtimeVersion, { force: true });
  return {
    status: 200,
    data: {
      refreshed: true,
      platform,
      runtimeVersion,
      available: Boolean(release?.manifest),
      updateId: release?.manifest?.id || null,
      appVersion: release?.manifest?.appVersion || null,
      commit: release?.manifest?.commit || null,
      createdAt: release?.manifest?.createdAt || null,
    },
  };
}

module.exports = {
  getManifest,
  getAsset,
  getStatus,
  refreshOta,
  extractTarGzToDir,
  __setTestFetcher,
};
