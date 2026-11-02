'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'stories-come-alive.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'user',          -- user | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_id TEXT NOT NULL,
  title TEXT NOT NULL,
  story TEXT NOT NULL DEFAULT '',
  episode TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  video_id INTEGER NOT NULL REFERENCES videos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
`);

// ---- migrations (safe on databases created before these columns existed) ----
const videoCols = db.prepare('PRAGMA table_info(videos)').all().map((r) => r.name);
if (!videoCols.includes('synopsis')) db.exec("ALTER TABLE videos ADD COLUMN synopsis TEXT NOT NULL DEFAULT ''");
if (!videoCols.includes('featured')) db.exec('ALTER TABLE videos ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

// ---- seed defaults (first run only) ----
if (getSetting('site_name') === null) setSetting('site_name', 'Stories Come Alive');
if (getSetting('youtube_url') === null) setSetting('youtube_url', '');
if (getSetting('facebook_url') === null) setSetting('facebook_url', '');
if (getSetting('logo_version') === null) setSetting('logo_version', '0');

const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
if (catCount === 0) {
  const seed = ['রোমান্স', 'রোমান্টিক কমেডি', 'হরর', 'থ্রিলার', 'মিস্ট্রি', 'ফ্যান্টাসি', 'ডার্ক ফ্যান্টাসি', 'সিরিজ'];
  const ins = db.prepare('INSERT INTO categories(name, sort_order) VALUES(?, ?)');
  seed.forEach((name, i) => ins.run(name, i));
}

function getAsset(key) {
  return db.prepare('SELECT mime, data FROM assets WHERE key = ?').get(key) || null;
}
function setAsset(key, mime, data) {
  db.prepare('INSERT INTO assets(key, mime, data) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data')
    .run(key, mime, data);
}
function deleteAsset(key) {
  db.prepare('DELETE FROM assets WHERE key = ?').run(key);
}

module.exports = { db, getSetting, setSetting, getAsset, setAsset, deleteAsset, DB_PATH };
