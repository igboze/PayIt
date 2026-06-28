#!/usr/bin/env node
// scripts/migrate-invoice-hd.js
//
// Database migration: Add HD wallet support to invoices table
// Adds columns: derivation_index, payment_address, expected_amount_micro, paid_tx_hash
// 
// Run once on deployment: node scripts/migrate-invoice-hd.js

const db = require("../src/db").db;

console.log("🔄 Migrating invoices table to add HD wallet support...");

try {
  // Check if columns already exist (idempotent)
  const tableInfo = db.prepare("PRAGMA table_info(invoices)").all();
  const columnNames = tableInfo.map(col => col.name);
  
  const needsMigration = !columnNames.includes("derivation_index");
  
  if (!needsMigration) {
    console.log("✅ Invoices table already has HD wallet columns. Skipping migration.");
    process.exit(0);
  }
  
  console.log("📝 Adding new columns to invoices table...");
  
  // Add new columns for HD wallet support
  db.exec(`
    ALTER TABLE invoices ADD COLUMN derivation_index INTEGER;
    ALTER TABLE invoices ADD COLUMN payment_address TEXT UNIQUE;
    ALTER TABLE invoices ADD COLUMN expected_amount_micro BIGINT;
    ALTER TABLE invoices ADD COLUMN paid_tx_hash TEXT;
  `);
  
  console.log("🔍 Creating indexes for HD wallet lookups...");
  
  // Create indexes
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_payment_address 
        ON invoices(payment_address);
      CREATE INDEX IF NOT EXISTS idx_invoices_derivation_index 
        ON invoices(telegram_id, derivation_index);
      CREATE INDEX IF NOT EXISTS idx_invoices_status 
        ON invoices(telegram_id, status);
    `);
  } catch (e) {
    console.warn("⚠️  Some indexes may already exist (this is OK):", e.message);
  }
  
  console.log("\n✅ Migration complete!");
  console.log("📌 New columns:");
  console.log("   - derivation_index: HD wallet derivation path index per invoice");
  console.log("   - payment_address: Unique address for this invoice (derived from master key)");
  console.log("   - expected_amount_micro: Expected payment in Arc's 18-decimal format");
  console.log("   - paid_tx_hash: Transaction hash when payment received");
  
  process.exit(0);
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
}
