-- ============================================
-- ZYRO CARDS — DATABASE SCHEMA (SQLite/Postgres compatible)
-- ============================================

-- Customers who sign up and own a profile
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- One row per profile (1-to-1 with users, kept separate so the
-- "public" data is cleanly isolated from auth data)
CREATE TABLE IF NOT EXISTS profiles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name      TEXT,
  job_title      TEXT,
  company        TEXT,
  bio            TEXT,
  phone          TEXT,
  email_public   TEXT,
  photo_url      TEXT,
  theme          TEXT DEFAULT 'classic',
  updated_at     TEXT DEFAULT (datetime('now'))
);

-- Custom links a user adds to their profile (LinkedIn, WhatsApp, website...)
CREATE TABLE IF NOT EXISTS profile_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  sort_order  INTEGER DEFAULT 0
);

-- Every physical NFC/QR card ever printed. Pre-generated in bulk by
-- the admin BEFORE it's sold. user_id stays NULL until the buyer
-- activates it.
CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  unique_code   TEXT UNIQUE NOT NULL,      -- goes into the NFC chip + QR code
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT DEFAULT 'unassigned', -- unassigned | active | disabled
  batch_name    TEXT,                      -- e.g. "Batch-2026-07"
  created_at    TEXT DEFAULT (datetime('now')),
  activated_at  TEXT
);

-- Every tap/scan, for the analytics feature
CREATE TABLE IF NOT EXISTS scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES cards(id),
  scanned_at  TEXT DEFAULT (datetime('now')),
  ip_address  TEXT,
  user_agent  TEXT
);

-- Simple admin accounts (separate from customer users table)
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
