// agent/store.js
// Persists AutoPay schedule metadata to a JSON file.
// Only { id, plan, createdAt } is written — PIN is never persisted to disk.

const fs   = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const STORE_PATH = path.join(__dirname, "..", "schedules.json");

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function saveSchedule(userId, plan) {
  const store  = loadStore();
  const jobId  = uuidv4();
  if (!store[userId]) store[userId] = [];
  store[userId].push({ id: jobId, plan, createdAt: new Date().toISOString() });
  saveStore(store);
  return jobId;
}

function removeSchedule(userId, jobId) {
  const store = loadStore();
  if (!store[userId]) return false;
  const before = store[userId].length;
  store[userId] = store[userId].filter(j => j.id !== jobId);
  saveStore(store);
  return store[userId].length < before;
}

function getUserSchedules(userId) {
  const store = loadStore();
  return store[userId] || [];
}

module.exports = { saveSchedule, removeSchedule, getUserSchedules };
