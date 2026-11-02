'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// ---------------------------------------------------------------------------
// Data layer — libSQL (Turso) with a local-file fallback.
//
// Hosted mode: when TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are both set in
// the environment, all data lives in the hosted Turso (libSQL) database, so
// accounts / videos / settings survive redeploys and restarts.
//
// Local fallback: with either variable unset, data lives in a local libSQL
// file at DATABASE_PATH (default: ../data/stories-come-alive.db) — exactly
// where the old node:sqlite build kept it.
//
// libSQL speaks the SQLite dialect, so the schema and queries below are the
// same ones the node:sqlite version used; only the access pattern changed
// (statements are async now).
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'stories-come-alive.db');

const TURSO_URL = String(process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = String(process.env.TURSO_AUTH_TOKEN || '').trim();
const useTurso = Boolean(TURSO_URL && TURSO_TOKEN);

let client;
let DB_TARGET;
if (useTurso) {
  client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  DB_TARGET = TURSO_URL;
} else {
  const filePath = path.resolve(DB_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  client = createClient({ url: 'file:' + filePath });
  DB_TARGET = filePath;
}

// ---------------- low-level query helpers (async) ----------------
async function queryAll(sql, args = []) {
  await ready;
  const rs = await client.execute({ sql, args });
  return rs.rows;
}
async function queryOne(sql, args = []) {
  const rows = await queryAll(sql, args);
  return rows.length ? rows[0] : null;
}
// Mirrors node:sqlite's statement.run() info shape.
async function run(sql, args = []) {
  await ready;
  const rs = await client.execute({ sql, args });
  return {
    changes: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid === null || rs.lastInsertRowid === undefined
      ? null
      : Number(rs.lastInsertRowid),
  };
}

// ---------------- raw helpers (no init gate; used by init itself) ----------------
async function rawGetSetting(key) {
  const rs = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return rs.rows.length ? rs.rows[0].value : null;
}
async function rawSetSetting(key, value) {
  await client.execute({
    sql: 'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value === null || value === undefined ? null : String(value)],
  });
}

// ---------------- schema + migrations + seeds (runs once at boot) ----------------
const ready = (async () => {
  if (!useTurso) {
    try { await client.execute('PRAGMA journal_mode = WAL'); } catch { /* best effort, local files only */ }
  }

  await client.executeMultiple(`
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
  const videoCols = (await client.execute('PRAGMA table_info(videos)')).rows.map((r) => r.name);
  if (!videoCols.includes('synopsis')) await client.execute("ALTER TABLE videos ADD COLUMN synopsis TEXT NOT NULL DEFAULT ''");
  if (!videoCols.includes('featured')) await client.execute('ALTER TABLE videos ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
  if (!videoCols.includes('rank')) await client.execute('ALTER TABLE videos ADD COLUMN rank INTEGER');
  if (!videoCols.includes('views')) await client.execute('ALTER TABLE videos ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
  const userCols = (await client.execute('PRAGMA table_info(users)')).rows.map((r) => r.name);
  if (!userCols.includes('avatar')) await client.execute('ALTER TABLE users ADD COLUMN avatar TEXT');

  // ---- seed defaults (first run only) ----
  if (await rawGetSetting('site_name') === null) await rawSetSetting('site_name', 'Stories Come Alive');
  if (await rawGetSetting('youtube_url') === null) await rawSetSetting('youtube_url', '');
  if (await rawGetSetting('facebook_url') === null) await rawSetSetting('facebook_url', '');
  if (await rawGetSetting('logo_version') === null) await rawSetSetting('logo_version', '0');

  const catCount = (await client.execute('SELECT COUNT(*) AS c FROM categories')).rows[0].c;
  if (Number(catCount) === 0) {
    const seed = ['Romance', 'Romantic Comedy', 'Horror', 'Thriller', 'Mystery', 'Fantasy', 'Dark Fantasy', 'Series'];
    await client.batch(
      seed.map((name, i) => ({ sql: 'INSERT INTO categories(name, sort_order) VALUES(?, ?)', args: [name, i] })),
      'write'
    );
  }

  // ---- one-time rename: Bengali seed category names -> English ----
  // Databases seeded by older builds carry the Bengali names. Rename each
  // one to its English equivalent, but ONLY when no category already has the
  // English name, so this never creates duplicates. Idempotent (after the
  // first pass the Bengali names are gone, so later boots change nothing)
  // and it leaves custom categories — of any name — untouched.
  const CATEGORY_RENAMES = [
    ['রোমান্স', 'Romance'],
    ['রোমান্টিক কমেডি', 'Romantic Comedy'],
    ['হরর', 'Horror'],
    ['থ্রিলার', 'Thriller'],
    ['মিস্ট্রি', 'Mystery'],
    ['ফ্যান্টাসি', 'Fantasy'],
    ['ডার্ক ফ্যান্টাসি', 'Dark Fantasy'],
    ['সিরিজ', 'Series'],
  ];
  for (const [bn, en] of CATEGORY_RENAMES) {
    const enCount = (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM categories WHERE name = ?', args: [en] })).rows[0].c;
    if (Number(enCount) === 0) {
      await client.execute({ sql: 'UPDATE categories SET name = ? WHERE name = ?', args: [en, bn] });
    }
  }
})();

// ---------------- public helpers (same names as the node:sqlite build) ----------------
async function getSetting(key) {
  await ready;
  return rawGetSetting(key);
}
async function setSetting(key, value) {
  await ready;
  return rawSetSetting(key, value);
}

async function getAsset(key) {
  const row = await queryOne('SELECT mime, data FROM assets WHERE key = ?', [key]);
  if (!row) return null;
  // libSQL returns BLOB values as ArrayBuffer; node:sqlite handed callers a
  // Uint8Array — normalize to Buffer so existing consumers keep working.
  let data = row.data;
  if (data instanceof ArrayBuffer) data = Buffer.from(data);
  else if (ArrayBuffer.isView(data) && !Buffer.isBuffer(data)) {
    data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return { mime: row.mime, data };
}
async function setAsset(key, mime, data) {
  await run(
    'INSERT INTO assets(key, mime, data) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data',
    [key, mime, data]
  );
}
async function deleteAsset(key) {
  await run('DELETE FROM assets WHERE key = ?', [key]);
}

module.exports = {
  ready,
  queryAll,
  queryOne,
  run,
  getSetting,
  setSetting,
  getAsset,
  setAsset,
  deleteAsset,
  DB_PATH,
  DB_TARGET,
};
