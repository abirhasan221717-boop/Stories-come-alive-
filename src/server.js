'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { ready, queryOne, queryAll, run, getSetting, setSetting, getAsset, setAsset, deleteAsset, DB_TARGET } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' })); // profile-avatar data URLs exceed the 100 KB default
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files (PNG/JPG/WebP/GIF/SVG) are allowed.'));
  },
});

// ---------------- helpers ----------------
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [saltHex, hashHex] = String(stored || '').split(':');
    if (!saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
async function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = await queryOne("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.kind = 'user'", [token]);
  return row || null;
}
async function isAdmin(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const row = await queryOne("SELECT token FROM sessions WHERE token = ? AND kind = 'admin'", [token]);
  return !!row;
}
async function startSession(res, cookieName, userId, kind) {
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions(token, user_id, kind) VALUES(?, ?, ?)', [token, userId, kind]);
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}
async function clearSession(req, res, cookieName, kind) {
  const token = parseCookies(req)[cookieName];
  if (token) await run('DELETE FROM sessions WHERE token = ? AND kind = ?', [token, kind]);
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; Max-Age=0`);
}
function extractYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return m[1]; }
  return null;
}
// Facebook video links: page videos, watch?v=, reels, share links and
// fb.watch short links. Returns the URL to hand to Facebook's embed
// plugin, or null when the input is not a recognizable Facebook video.
// (Checked before YouTube: a numeric Facebook v= of 11+ digits would
// otherwise match the YouTube v= pattern.)
function extractFacebookUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const noScheme = s.replace(/^https?:\/\//i, '');
  const short = noScheme.match(/^fb\.watch\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
  if (short) return 'https://fb.watch/' + short[1] + '/';
  const m = noScheme.match(/^(?:www\.|m\.|web\.)?facebook\.com(\/.*)?$/i);
  if (!m) return null;
  const path = (m[1] || '/').split('#')[0];
  if (/\/videos\/\d+/.test(path)) return 'https://www.facebook.com' + path;
  if (/\/reel\/\d+/.test(path)) return 'https://www.facebook.com' + path;
  if (/\/share\/[vr]\/[A-Za-z0-9_-]+/.test(path)) return 'https://www.facebook.com' + path;
  if (/[?&]v=\d+/.test(path)) return 'https://www.facebook.com' + path;
  return null;
}
// Accepts a YouTube or Facebook video link; returns how to store it.
function parseVideoLink(input) {
  const fb = extractFacebookUrl(input);
  if (fb) return { source: 'facebook', youtubeId: '', url: fb };
  const yid = extractYouTubeId(input);
  if (yid) return { source: 'youtube', youtubeId: yid, url: '' };
  return null;
}
const VIDEO_LINK_ERROR = 'Please paste a valid YouTube or Facebook video link.';
function subscribeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  // For channel/handle URLs, jump straight to YouTube's subscribe-confirm screen.
  if (/youtube\.com\/(channel\/|@|c\/|user\/)/.test(u) && !u.includes('?')) return u + '?sub_confirmation=1';
  return u;
}

// ---- social link lists (multiple YouTube channels / Facebook pages) ----
// Stored as JSON in settings under youtube_links / facebook_links: an array
// of { label, url }. Migration is seamless: while the new key has never been
// saved (getSetting returns null) the legacy single youtube_url /
// facebook_url value is used as a one-item list; once the admin saves — even
// an empty list — the new key wins, so deleting every link really deletes
// them (the legacy value never resurrects). Saving also rewrites the legacy
// key to the first link's URL (or '') so anything reading the old key stays
// roughly in sync.
function parseLinkList(raw) {
  if (raw === null || raw === undefined) return null; // never saved
  let arr;
  try { arr = JSON.parse(String(raw)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const url = String(e.url || '').trim();
    if (!url) continue;
    out.push({ label: String(e.label || '').trim(), url });
  }
  return out;
}
async function getLinkList(newKey, legacyKey) {
  const saved = parseLinkList(await getSetting(newKey));
  if (saved !== null) return saved;
  const legacy = String((await getSetting(legacyKey)) || '').trim();
  return legacy ? [{ label: '', url: legacy }] : [];
}
function getYoutubeLinks() { return getLinkList('youtube_links', 'youtube_url'); }
function getFacebookLinks() { return getLinkList('facebook_links', 'facebook_url'); }
// One admin-form row -> a clean { label, url } entry, or null when the row is
// blank or the URL is not a usable http(s) link.
function cleanLinkEntry(labelRaw, urlRaw) {
  let url = String(urlRaw || '').trim();
  if (!url) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) url = 'https://' + url; // scheme missing
  if (url.length > 500) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { label: String(labelRaw || '').trim().slice(0, 60), url };
}
// Repeated form fields arrive as an array, a single string (one row), or
// undefined (no rows at all). Normalize, drop bad rows, dedupe by URL, cap.
function linkListFromForm(labelField, urlField) {
  const asArray = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
  const labels = asArray(labelField);
  const urls = asArray(urlField);
  const out = [];
  const seen = new Set();
  const count = Math.max(labels.length, urls.length);
  for (let i = 0; i < count && out.length < 20; i++) {
    const entry = cleanLinkEntry(labels[i], urls[i]);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

// Minimal single-color line icons for the whole UI (thin stroke style,
// no pictographic emoji anywhere). Decorative only: aria-hidden, sized
// and spaced by the .ic / .ic-sm classes in styles.css.
const lineIcon = (inner, small) => `<svg class="${small ? 'ic ic-sm' : 'ic'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const HEART_PATH = '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>';
const PLAY_PATH = '<path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10-6.6c.6-.4.6-1.4 0-1.8l-10-6.6c-.7-.4-1.6.1-1.6.9z"/>';
const USERS_PATH = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>';
const LOCK_PATH = '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>';
const STAR_POINTS = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
const HOME_PATH = '<path d="M3 9.5L12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22v-8h6v8"/>';
const ICONS = {
  grid: lineIcon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  playRect: lineIcon('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.6 9.7l4.6 2.3-4.6 2.3z"/>'),
  play: lineIcon(PLAY_PATH),
  playSm: lineIcon(PLAY_PATH, true),
  plusCircle: lineIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8.5v7M8.5 12h7"/>'),
  pencil: lineIcon('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  layers: lineIcon('<path d="M12 3l9 4.9-9 4.9-9-4.9z"/><path d="M3.4 12.4L12 17l8.6-4.6"/><path d="M3.4 16.4L12 21l8.6-4.6"/>'),
  users: lineIcon(USERS_PATH),
  usersSm: lineIcon(USERS_PATH, true),
  gear: lineIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  external: lineIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M21 3l-9.5 9.5"/>'),
  image: lineIcon('<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15.5L16 10.5 5 21"/>'),
  key: lineIcon('<circle cx="8" cy="15.5" r="4.8"/><path d="M11.4 12.1L20.5 3"/><path d="M17.3 6.2l2 2"/>'),
  lock: lineIcon(LOCK_PATH),
  lockSm: lineIcon(LOCK_PATH, true),
  eyeSm: lineIcon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>', true),
  star: lineIcon(STAR_POINTS),
  starSm: lineIcon(STAR_POINTS, true),
  starFilled: `<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${STAR_POINTS}</svg>`,
  bell: lineIcon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  heart: lineIcon(HEART_PATH),
  heartFilled: `<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${HEART_PATH}</svg>`,
  home: lineIcon(HOME_PATH),
  homeSm: lineIcon(HOME_PATH, true),
  user: lineIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  userPlus: lineIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>'),
  book: lineIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  search: lineIcon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>'),
  info: lineIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>'),
  camera: lineIcon('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  plus: lineIcon('<path d="M12 5v14M5 12h14"/>'),
  folder: lineIcon('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.4L11 7.5h7.5A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z"/>'),
  link: lineIcon('<path d="M10 13.6a5 5 0 0 0 7.1.4l2.8-2.8a5 5 0 0 0-7-7.1L11.5 5.5"/><path d="M14 10.4a5 5 0 0 0-7.1-.4L4.1 12.8a5 5 0 0 0 7 7.1l1.4-1.4"/>'),
  chevronRight: '<svg class="ic qa-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg>',
};

// Welcome-page button caption: the label when there is one; the plain
// platform name for a single link; platform + position when several links
// share no label, so the buttons stay distinguishable.
function socialBtnText(kind, links, link, index) {
  const isYt = kind === 'youtube';
  const base = isYt ? ICONS.play + 'Subscribe' : ICONS.userPlus + 'Follow';
  const platform = isYt ? 'YouTube' : 'Facebook';
  if (link.label) return `${base} — ${esc(link.label)}`;
  return links.length > 1 ? `${base} on ${platform} ${index + 1}` : `${base} on ${platform}`;
}
// Display names for the Follow / Subscribe panel: the admin's label when
// present, otherwise a name derived from the URL itself.
function parseSocialUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) url = 'https://' + url;
  try { return new URL(url); } catch { return null; }
}
function prettifySlug(slug) {
  let s = String(slug || '');
  try { s = decodeURIComponent(s); } catch { /* keep the raw slug */ }
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function deriveSocialName(kind, url) {
  const fallback = kind === 'youtube' ? 'YouTube Channel' : 'Facebook Page';
  const parsed = parseSocialUrl(url);
  if (!parsed) return fallback;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length) return fallback;
  if (kind === 'youtube') {
    if (segments[0].startsWith('@')) {
      return prettifySlug(segments[0].slice(1)) || fallback;
    }
    return fallback; // /channel/UC…, /c/…, /user/… and anything else
  }
  // Facebook: the first path segment is normally the page slug; a few
  // reserved shapes (profile.php?id=…, groups/…, watch/…) carry no name.
  const first = segments[0];
  if (/^(profile\.php|groups|watch|events|pages)$/i.test(first) || /^\d+$/.test(first)) return fallback;
  return prettifySlug(first) || fallback;
}
function socialDisplayNames(kind, links) {
  const seen = new Map();
  return links.map((link) => {
    const base = String(link.label || '').trim() || deriveSocialName(kind, link.url);
    const key = base.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count > 1 ? `${base} ${count}` : base;
  });
}
function followPanelHtml(ytLinks, fbLinks) {
  const ytNames = socialDisplayNames('youtube', ytLinks);
  const fbNames = socialDisplayNames('facebook', fbLinks);
  const ytGroup = ytLinks.length ? `
      <div class="follow-group">
        <h3 class="follow-group-title">YouTube Channels</h3>
        <div class="follow-rows">
          ${ytLinks.map((l, i) => `<div class="follow-row">
            <span class="follow-avatar follow-avatar-youtube" aria-hidden="true">▶</span>
            <span class="follow-name">${esc(ytNames[i])}</span>
            <a class="btn btn-youtube btn-sm follow-action" href="${esc(subscribeUrl(l.url))}" target="_blank" rel="noopener">Subscribe</a>
          </div>`).join('')}
        </div>
      </div>` : '';
  const fbGroup = fbLinks.length ? `
      <div class="follow-group">
        <h3 class="follow-group-title">Facebook Pages</h3>
        <div class="follow-rows">
          ${fbLinks.map((l, i) => `<div class="follow-row">
            <span class="follow-avatar follow-avatar-facebook" aria-hidden="true">f</span>
            <span class="follow-name">${esc(fbNames[i])}</span>
            <a class="btn btn-facebook btn-sm follow-action" href="${esc(l.url)}" target="_blank" rel="noopener">Follow</a>
          </div>`).join('')}
        </div>
      </div>` : '';
  if (!ytGroup && !fbGroup) return '';
  return `
<div class="follow-overlay" id="followPanel" data-follow-panel hidden role="dialog" aria-modal="true" aria-labelledby="followPanelTitle">
  <section class="follow-sheet">
    <div class="follow-head">
      <h2 id="followPanelTitle">Follow &amp; Subscribe</h2>
      <button type="button" class="follow-close" data-follow-close aria-label="Close">✕</button>
    </div>
    <div class="follow-list">${ytGroup}${fbGroup}
    </div>
  </section>
</div>`;
}
async function siteName() { return (await getSetting('site_name')) || 'Stories Come Alive'; }
async function logoSrc() { return '/brand/logo?v=' + ((await getSetting('logo_version')) || '0'); }
// Two-tone public wordmark: with three or more words the second word is
// wrapped so it can render in gold. One- and two-word names render as-is.
// The name itself still comes from Settings; nothing is hardcoded here.
function brandNameHtml(name) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  if (words.length < 3) return esc(name);
  return words.map((w, i) => (i === 1 ? `<span class="brand-gold">${esc(w)}</span>` : esc(w))).join(' ');
}
function allCategories() {
  return queryAll(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
                     FROM categories c ORDER BY c.sort_order, c.id`);
}
function videoRow(id) {
  return queryOne(`SELECT v.*, c.name AS category_name FROM videos v
                     LEFT JOIN categories c ON c.id = v.category_id WHERE v.id = ?`, [id]);
}
function safeNext(next, fallback) {
  const n = String(next || '');
  return n.startsWith('/') && !n.startsWith('//') ? n : fallback;
}
// Obvious way back / home for inner user pages (profile, favorites, watch).
function backBar() {
  return `<nav class="backbar">
    <button type="button" class="btn btn-ghost btn-sm" data-back>← Back</button>
    <a class="btn btn-ghost btn-sm" href="/">${ICONS.homeSm}Home</a>
  </nav>`;
}

// ---------------- layout ----------------
async function layout(req, { title, body, user }) {
  const name = await siteName();
  const logo = await logoSrc();
  const ytLinks = await getYoutubeLinks();
  const fbLinks = await getFacebookLinks();
  const notifCount = user ? await unreadNotifCount(user) : 0;
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? title + ' — ' + name : name)}</title>
<link rel="icon" href="/brand/logo">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v=36">
</head>
<body class="pubui">
<header class="topbar">
  <a class="brand" href="/">
    <img class="brand-logo" src="${logo}" alt="${esc(name)}">
    <span class="brand-name">${brandNameHtml(name)}</span>
  </a>
  <div class="userbox">
    ${(ytLinks.length || fbLinks.length) ? '<button type="button" class="btn btn-main btn-follow" data-follow-open aria-haspopup="dialog" aria-controls="followPanel">' + ICONS.bell + 'Follow / Subscribe</button>' : ''}
    ${user
      ? `<a class="navlink bell-link" href="/notifications" aria-label="Notifications">${ICONS.bell}${notifCount ? `<span class="bell-badge">${notifCount > 9 ? '9+' : notifCount}</span>` : ''}</a>
         <a class="navlink" href="/favorites">${ICONS.heart}Favorites</a>
         <a class="navlink" href="/profile">${user.avatar ? `<img class="nav-avatar" src="${esc(user.avatar)}" alt="">` : ICONS.user} Profile</a>
         <form method="POST" action="/logout" class="inlineform"><button class="btn btn-ghost btn-sm" type="submit">Logout</button></form>`
      : `<a class="navlink" href="/register">Register</a>
         <a class="btn btn-main signin-pill" href="/login">${ICONS.user}Sign In</a>`}
  </div>
</header>
<main>
${body}
</main>
<footer class="footer">
  <img class="footer-logo" src="${logo}" alt="">
  <div class="hairline-row footer-brand"><span class="hairline" aria-hidden="true"></span><span>${brandNameHtml(name)}</span><span class="hairline" aria-hidden="true"></span></div>
  ${(ytLinks.length || fbLinks.length) ? '<p class="footer-follow">FOLLOW US</p>' : ''}
  <div class="footer-links">
    ${ytLinks.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${ICONS.playSm}${esc(l.label || 'YouTube')}</a>`).join('')}
    ${fbLinks.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${ICONS.usersSm}${esc(l.label || 'Facebook')}</a>`).join('')}
    <a href="/privacy-policy">Privacy Policy</a>
    <a href="/admin">Admin</a>
  </div>
  <p class="footer-copy">© ${new Date().getFullYear()} ${esc(name)} — All rights reserved.</p>
</footer>
${followPanelHtml(ytLinks, fbLinks)}
<script src="/app.js?v=36"></script>
</body>
</html>`;
}

// Admin pages: map the page title to a nav key so the current page's item
// in the hamburger menu can be highlighted. Unknown titles (setup / login)
// simply highlight none. Labels are plain text — no emoji icons.
const ADMIN_NAV = [
  { key: 'dashboard', href: '/admin', label: 'Dashboard', icon: ICONS.grid, titles: ['Dashboard'] },
  { key: 'videos', href: '/admin/videos', label: 'Videos', icon: ICONS.playRect, titles: ['Videos', 'Edit Video'] },
  { key: 'comments', href: '/admin/comments', label: 'Comments', icon: ICONS.layers, titles: ['Comments'] },
  { key: 'categories', href: '/admin/categories', label: 'Categories', icon: ICONS.layers, titles: ['Categories'] },
  { key: 'users', href: '/admin/users', label: 'Users', icon: ICONS.users, titles: ['Users'] },
  { key: 'settings', href: '/admin/settings', label: 'Settings', icon: ICONS.gear, titles: ['Settings'] },
];

async function adminLayout({ title, body, bare = false }) {
  const name = await siteName();
  const logo = await logoSrc();
  const activeKey = (ADMIN_NAV.find((n) => n.titles.includes(title)) || {}).key || '';
  const header = bare ? `
<header class="topbar admin-topbar admin-topbar-bare">
  <a class="brand" href="/admin">
    <img class="brand-logo" src="${logo}" alt="">
    <span class="brand-name">${esc(name)} — Admin</span>
  </a>
</header>` : `
<header class="topbar admin-topbar">
  <a class="brand" href="/admin">
    <img class="brand-logo" src="${logo}" alt="">
    <span class="brand-name">${esc(name)} — Admin</span>
  </a>
  <div class="admin-headbtns">
    <a class="gearbtn" href="/admin/settings" aria-label="Settings" title="Settings">${ICONS.gear}</a>
    <form method="POST" action="/admin/logout" class="inlineform"><button class="btn btn-logout" type="submit">Logout</button></form>
    <div class="adminmenu-wrap">
      <button type="button" class="hambtn" data-admin-menu-btn aria-haspopup="true" aria-expanded="false" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
      <nav class="adminmenu" data-admin-menu hidden>
        ${ADMIN_NAV.map((n) => `<a class="adminmenu-link${n.key === activeKey ? ' active' : ''}" href="${n.href}">${n.icon}${n.label}</a>`).join('')}
        <a class="adminmenu-link" href="/" target="_blank">${ICONS.external}View Site</a>
      </nav>
    </div>
  </div>
</header>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Admin — ${esc(name)}</title>
<link rel="icon" href="/brand/logo">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v=36">
</head>
<body class="adminui">
${header}
<main>
${body}
</main>
<script src="/app.js?v=36"></script>
</body>
</html>`;
}

// Facebook exposes no public thumbnail URL, so its cards and hero fall
// back to the site's brand hero artwork (/banner.jpg — the same image
// the homepage hero uses when no video is featured).
function cardThumb(v) {
  return v.source === 'facebook' ? '/banner.jpg' : `https://i.ytimg.com/vi/${esc(v.youtube_id)}/hqdefault.jpg`;
}

function videoCard(v, user, pos) {
  const totalViews = Number(v.views || 0) + Number(v.yt_views || 0);
  return `<a class="card" href="/watch/${v.id}">
    <div class="thumb">
      <img loading="lazy" src="${cardThumb(v)}" alt="${esc(v.title)}">
      ${pos ? `<span class="rank-chip">Top ${pos}</span>` : ''}
      ${pos ? `<span class="rank-big" aria-hidden="true">${pos}</span>` : ''}
      ${isFreshVideo(v) ? '<span class="new-chip">NEW</span>' : ''}
      ${v.episode ? `<span class="ep-badge">${esc(v.episode)}</span>` : ''}
      <span class="play-badge">▶</span>
    </div>
    <div class="card-body">
      <h3>${esc(v.title)}</h3>
      ${v.story ? `<p class="card-story">${esc(v.story)}</p>` : ''}
      ${v.category_name ? `<p class="card-cat">${esc(v.category_name)}</p>` : ''}
      <p class="card-views">${ICONS.eyeSm} ${totalViews} ${totalViews === 1 ? 'view' : 'views'}</p>
      ${Number(v.rating_count || 0) > 0 ? `<p class="card-views card-rating">${ICONS.starSm} ${Number(v.rating_avg || 0).toFixed(1)} (${Number(v.rating_count)})</p>` : ''}
      ${user ? '' : '<p class="card-lock">' + ICONS.lockSm + 'Sign in to watch</p>'}
    </div>
  </a>`;
}
function grid(videos, user) {
  if (!videos.length) return '<div class="empty">No videos yet — coming soon!</div>';
  return `<div class="grid">${videos.map((v) => videoCard(v, user)).join('')}</div>`;
}

// Horizontally scrollable poster-card row (bhoot-style homepage rows).
// With ranked=true (the Top Picks row), cards get a "Top N" chip plus a
// big Bhoot-style rank number, and the row auto-slides on its own.
function posterRow({ title, videos, user, moreHref, ranked = false }) {
  if (!videos.length) return '';
  return `<section class="section rowsection">
    <div class="rowhead">
      <h2 class="section-title">${title}</h2>
      ${moreHref ? `<a class="rowmore" href="${moreHref}">View All →</a>` : ''}
    </div>
    <div class="rowwrap">
      <div class="rowscroll"${ranked ? ' data-autoslide' : ''}>${videos.map((v, i) => videoCard(v, user, ranked ? i + 1 : 0)).join('')}</div>
      <button class="rowbtn rowbtn-prev" type="button" data-scroll="prev" aria-label="Previous videos">‹</button>
      <button class="rowbtn rowbtn-next" type="button" data-scroll="next" aria-label="More videos">›</button>
    </div>
  </section>`;
}
function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}
// created_at values come from SQLite datetime('now') — UTC, "YYYY-MM-DD
// HH:MM:SS" with no zone marker. Parse them as UTC for display math.
function parseDbTime(ts) {
  const s = String(ts || '');
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}
function relTime(ts) {
  const d = parseDbTime(ts);
  if (!d) return String(ts || '').slice(0, 10);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + ' d ago';
  return String(ts).slice(0, 10);
}
function isFreshVideo(v) {
  const d = parseDbTime(v && v.created_at);
  return !!d && (Date.now() - d.getTime()) < 7 * 24 * 3600 * 1000;
}
async function unreadNotifCount(user) {
  if (!user) return 0;
  const row = await queryOne('SELECT COUNT(*) AS c FROM notifications WHERE id > ?', [Number(user.last_seen_notif || 0)]);
  return Number(row.c);
}
// Commenter avatar: their profile photo when set, else a gold circle with
// the first letter of their name (same fallback idea as the header).
function commentAvatarHtml(name, avatar) {
  if (avatar) return `<img class="comment-avatar" src="${esc(avatar)}" alt="">`;
  const initial = [...String(name || '?').trim()][0] || '?';
  return `<span class="comment-avatar comment-avatar-initial" aria-hidden="true">${esc(initial.toUpperCase())}</span>`;
}
// Star for the rating control: filled (gold, currentColor fill) or outline.
function starIcon(filled, small) {
  return `<svg class="${small ? 'ic ic-sm' : 'ic'}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${STAR_POINTS}</svg>`;
}
// Bulk-load rating aggregates onto an array of video rows (cards render
// synchronously, so routes attach rating_avg / rating_count beforehand).
async function attachRatings(videos) {
  if (!videos || !videos.length) return videos;
  const ids = [...new Set(videos.map((v) => Number(v.id)).filter(Boolean))];
  if (!ids.length) return videos;
  const rows = await queryAll(`SELECT video_id, AVG(stars) AS a, COUNT(*) AS c FROM ratings
    WHERE video_id IN (${ids.map(() => '?').join(',')}) GROUP BY video_id`, ids);
  const byId = new Map(rows.map((r) => [Number(r.video_id), r]));
  for (const v of videos) {
    const r = byId.get(Number(v.id));
    v.rating_avg = r ? Number(r.a) : null;
    v.rating_count = r ? Number(r.c) : 0;
  }
  return videos;
}

// ---------------- YouTube view counts ----------------
// Real YouTube view counts are cached in videos.yt_views and refreshed
// from the YouTube Data API when YOUTUBE_API_KEY is configured: lazily
// from the homepage once the cache is over 6 hours old, or on demand via
// the admin Videos page. Facebook videos always keep yt_views = 0. Any
// API/network failure is fail-soft — the previous counts stay in place.
function ytApiBase() {
  return String(process.env.YT_API_BASE_URL || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');
}
let ytRefreshInFlight = false;
async function refreshYtViews() {
  const key = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (!key || ytRefreshInFlight) return false;
  ytRefreshInFlight = true;
  try {
    const vids = await queryAll("SELECT id, youtube_id FROM videos WHERE source = 'youtube' AND youtube_id != ''");
    for (let i = 0; i < vids.length; i += 50) {
      const batch = vids.slice(i, i + 50);
      const url = `${ytApiBase()}/videos?part=statistics&id=${encodeURIComponent(batch.map((v) => v.youtube_id).join(','))}&key=${encodeURIComponent(key)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      let data;
      try {
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error('YouTube API HTTP ' + resp.status);
        data = await resp.json();
      } finally { clearTimeout(timer); }
      const byYtId = new Map(batch.map((v) => [String(v.youtube_id), Number(v.id)]));
      for (const item of (data && data.items) || []) {
        const vid = byYtId.get(String(item && item.id));
        const count = Number(item && item.statistics && item.statistics.viewCount);
        if (vid !== undefined && Number.isFinite(count)) {
          await run('UPDATE videos SET yt_views = ? WHERE id = ?', [count, vid]);
        }
      }
    }
    await setSetting('yt_refreshed_at', String(Date.now()));
    return true;
  } catch {
    return false; // fail-soft: keep the old counts
  } finally {
    ytRefreshInFlight = false;
  }
}
// Fire-and-forget homepage trigger: never awaited, so a slow or failing
// API can never delay a page render; fresh numbers appear on later loads.
function maybeRefreshYtViews() {
  (async () => {
    try {
      if (!String(process.env.YOUTUBE_API_KEY || '').trim()) return;
      const last = Number((await getSetting('yt_refreshed_at')) || 0);
      if (!last || Date.now() - last > 6 * 3600 * 1000) refreshYtViews().catch(() => {});
    } catch { /* a refresh check must never break the homepage */ }
  })();
}

// ---------------- brand logo ----------------
app.get('/brand/logo', async (req, res) => {
  const asset = await getAsset('logo');
  if (asset) {
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(asset.data));
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'logo.png'));
});

// ---------------- public pages ----------------
app.get('/', async (req, res) => {
  maybeRefreshYtViews(); // fire-and-forget: fresh YouTube counts land on later loads
  const user = await currentUser(req);
  const name = await siteName();
  const featured = await queryOne(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.featured = 1 ORDER BY v.id DESC LIMIT 1`);
  // Top Picks is automatic: a combined score of total views (site views +
  // real YouTube views) plus fan ratings (average stars × 100), so a
  // much-loved video can outrank a merely much-watched one. Only videos
  // with some signal (views or ratings) appear; newest wins ties.
  const topPicks = await queryAll(`SELECT v.*, c.name AS category_name,
      COALESCE(r.a, 0) AS rating_avg, COALESCE(r.c, 0) AS rating_count
    FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    LEFT JOIN (SELECT video_id, AVG(stars) AS a, COUNT(*) AS c FROM ratings GROUP BY video_id) r ON r.video_id = v.id
    WHERE (v.views + v.yt_views) + COALESCE(r.a, 0) * 100 > 0
    ORDER BY (v.views + v.yt_views) + COALESCE(r.a, 0) * 100 DESC, v.id DESC LIMIT 10`);
  // The featured video's own position in that same ordering (for its badge).
  let featuredTopPos = 0;
  if (featured) {
    const fRow = await queryOne(`SELECT (v.views + v.yt_views) + COALESCE(r.a, 0) * 100 AS score FROM videos v
      LEFT JOIN (SELECT video_id, AVG(stars) AS a FROM ratings GROUP BY video_id) r ON r.video_id = v.id
      WHERE v.id = ?`, [featured.id]);
    const fScore = fRow ? Number(fRow.score) : 0;
    if (fScore > 0) {
      const ahead = await queryOne(`SELECT COUNT(*) AS c FROM videos v
        LEFT JOIN (SELECT video_id, AVG(stars) AS a FROM ratings GROUP BY video_id) r ON r.video_id = v.id
        WHERE (v.views + v.yt_views) + COALESCE(r.a, 0) * 100 > ?
           OR ((v.views + v.yt_views) + COALESCE(r.a, 0) * 100 = ? AND v.id > ?)`,
        [fScore, fScore, featured.id]);
      featuredTopPos = Number(ahead.c) + 1;
    }
  }
  const latest = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC LIMIT 12`);
  await attachRatings(topPicks);
  await attachRatings(latest);

  // Big homepage hero: a manually featured video wins; otherwise the hero
  // automatically showcases the current Top 1 video (Bhoot-style), so the
  // top story is always big on the homepage with no admin work needed.
  const heroVideo = featured || (topPicks.length ? topPicks[0] : null);
  const heroTopPos = featured ? featuredTopPos : (heroVideo ? 1 : 0);

  let hero;
  if (heroVideo) {
    hero = `
  <section class="fhero">
    ${heroVideo.source === 'facebook'
      ? `<img class="fhero-img" src="/banner.jpg" alt="${esc(heroVideo.title)}">`
      : `<img class="fhero-img" src="https://i.ytimg.com/vi/${esc(heroVideo.youtube_id)}/maxresdefault.jpg"
      onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${esc(heroVideo.youtube_id)}/hqdefault.jpg'" alt="${esc(heroVideo.title)}">`}
    <div class="fhero-shade"></div>
    <div class="fhero-content">
      ${heroTopPos ? `<span class="fhero-topbadge">Top ${heroTopPos}</span>` : ''}
      ${heroVideo.category_name ? `<span class="fhero-badge">${esc(heroVideo.category_name)}</span>` : ''}
      <h1 class="fhero-title">${esc(heroVideo.title)}</h1>
      ${heroVideo.story ? `<p class="fhero-story">${esc(heroVideo.story)}${heroVideo.episode ? ' • ' + esc(heroVideo.episode) : ''}</p>` : ''}
      ${heroVideo.synopsis ? `<p class="fhero-syn" data-syn>${esc(heroVideo.synopsis)}</p>${String(heroVideo.synopsis).trim().length > 160 ? '<button type="button" class="syn-toggle" data-syn-toggle>Read More</button>' : ''}` : ''}
      <div class="fhero-btns">
        <a class="btn btn-main fhero-btn" href="/watch/${heroVideo.id}">▶ Watch Now</a>
        <a class="btn fhero-btn fhero-btn-info" href="/watch/${heroVideo.id}">${ICONS.info} More Info</a>
      </div>
      ${user ? '' : '<p class="fhero-note">Sign in to watch — new here? Create a free account.</p>'}
    </div>
  </section>
  <section class="hero-search">
    <form class="searchbar" method="GET" action="/search">
      <span class="searchwrap">${ICONS.search}<input type="text" name="q" placeholder="Search stories…"></span>
      <button class="btn btn-main" type="submit">Search</button>
    </form>
  </section>`;
  } else {
    hero = `
  <section class="hero">
    <img class="hero-art" src="/banner.jpg" alt="${esc(name)}">
    <div class="hero-overlay">
      <h1 class="sr-only">${esc(name)}</h1>
      <div class="hairline-row"><span class="hairline" aria-hidden="true"></span><p>A library of story videos, sorted by category — pick a story and start watching.</p><span class="hairline" aria-hidden="true"></span></div>
      <form class="searchbar" method="GET" action="/search">
        <span class="searchwrap">${ICONS.search}<input type="text" name="q" placeholder="Search stories…"></span>
        <button class="btn btn-main" type="submit">Search</button>
      </form>
      ${user ? '' : '<div class="hairline-row"><span class="hairline" aria-hidden="true"></span><p class="hero-note"><a href="/login">Sign in</a> to watch, or <a href="/register">create a free account</a>.</p><span class="hairline" aria-hidden="true"></span></div>'}
    </div>
  </section>`;
  }

  let rows = '';
  if (topPicks.length) rows += posterRow({ title: 'Top Picks', videos: topPicks, user, ranked: true });
  rows += posterRow({ title: 'Latest Stories', videos: latest, user });
  for (const c of await allCategories()) {
    if (!c.video_count) continue;
    const vids = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC LIMIT 12`, [c.id]);
    await attachRatings(vids);
    rows += posterRow({ title: esc(c.name), videos: vids, user, moreHref: `/category/${c.id}` });
  }
  if (!latest.length) {
    rows = `<section class="section"><div class="empty empty-home"><span class="empty-book">${ICONS.book}</span>No videos yet — coming soon!</div></section>`;
  }
  res.send(await layout(req, { title: '', body: hero + rows, user }));
});

app.get('/category/:id', async (req, res) => {
  const user = await currentUser(req);
  const cat = await queryOne('SELECT * FROM categories WHERE id = ?', [Number(req.params.id)]);
  if (!cat) return res.status(404).send(await layout(req, { title: 'Not Found', user, body: '<div class="empty">This category could not be found.</div>' }));
  const videos = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC`, [cat.id]);
  await attachRatings(videos);
  const body = `
  <section class="section">
    <h2 class="section-title">${esc(cat.name)}</h2>
    <p class="muted">${videos.length} video${videos.length === 1 ? '' : 's'}</p>
    ${grid(videos, user)}
  </section>`;
  res.send(await layout(req, { title: cat.name, body, user }));
});

app.get('/search', async (req, res) => {
  const user = await currentUser(req);
  const q = String(req.query.q || '').trim();
  const like = '%' + q + '%';
  const videos = q ? await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    WHERE v.title LIKE ? OR v.story LIKE ? ORDER BY v.id DESC`, [like, like]) : [];
  await attachRatings(videos);
  const body = `
  <section class="section">
    <h2 class="section-title">Search results</h2>
    ${q ? `<p class="muted">for &ldquo;${esc(q)}&rdquo;</p>` : ''}
    ${q ? grid(videos, user) : '<div class="empty">Type something to search.</div>'}
  </section>`;
  res.send(await layout(req, { title: 'Search', body, user }));
});

app.get('/privacy-policy', async (req, res) => {
  const user = await currentUser(req);
  const body = `
  <section class="section">
    <h2 class="section-title">Privacy Policy</h2>
    <p>Stories Come Alive is a free library of story videos, organized by category. All of the videos are embedded from YouTube and play in YouTube's player — we do not host the videos ourselves. This policy explains, in plain language, what information we collect when you use the site and what we do with it.</p>
    <h3>What we collect</h3>
    <p>When you create an account, we collect your name and email address, and your password. Your password is stored only in a scrambled (hashed) form — we never store your real password. You can also add an optional profile photo, and we keep the list of videos you save as favorites.</p>
    <h3>Signing in with Google</h3>
    <p>If you sign in with Google, Google shares your name, email address and profile picture with us. We use them only to create your account and sign you in — for nothing else.</p>
    <h3>How we use your information</h3>
    <p>We use this information only to run the site: to operate your account, keep you signed in, and remember your favorites and profile photo. We do not sell your personal information to third parties, and we do not use it for advertising.</p>
    <h3>Cookies</h3>
    <p>We use a session cookie to keep you signed in as you move around the site. Without it, the site could not remember your login between pages. We do not set advertising or tracking cookies of our own.</p>
    <h3>YouTube videos</h3>
    <p>When you watch a video, the player is loaded from YouTube, and YouTube (Google) may set its own cookies and collect information under its own privacy policy. That activity is governed by Google's policies, not by ours.</p>
    <h3>Where your data is stored</h3>
    <p>Your account information is stored in the site's hosted database, and it is kept for as long as your account exists.</p>
    <h3>Your account and contact</h3>
    <p>If you have any question about your privacy, or you would like your account and its data deleted, please email us at <a href="mailto:bi4994331@gmail.com">bi4994331@gmail.com</a> and we will take care of it.</p>
    <p class="muted">Last updated: November 2, 2026</p>
  </section>`;
  res.send(await layout(req, { title: 'Privacy Policy', body, user }));
});

// ---------------- Google sign-in (optional) ----------------
// Enabled only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in the
// environment. Without them the Google buttons simply don't render and the
// password flow is exactly as before. OAuth 2.0 is done by hand with fetch.
function googleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function googleRedirectUri(req) {
  // Derived from the request host so the same code works on localhost (http,
  // for testing) and on the production domain (https, behind Render's proxy).
  const host = req.get('host') || 'localhost';
  const scheme = /^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https';
  return `${scheme}://${host}/auth/google/callback`;
}
const GOOGLE_STATE_COOKIE = 'google_oauth';
// startSession replaces the Set-Cookie header, so cookie additions in the
// Google flow go through this appender to avoid clobbering each other.
function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}
function googleButton(next, label) {
  const href = '/auth/google' + (next ? '?next=' + encodeURIComponent(next) : '');
  return `<a class="btn btn-google" href="${href}">
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303C33.654 32.657 29.223 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
      <span>${label}</span></a>
    <div class="auth-divider"><span>Or</span></div>`;
}

// ---------------- auth ----------------
async function authPage(req, { mode, error, next }) {
  const isLogin = mode === 'login';
  const logo = await logoSrc();
  const body = `
  <section class="auth-wrap">
    <div class="auth-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>${isLogin ? 'Sign In' : 'Create Account'}</h1>
      <p class="muted">${isLogin ? 'Sign in to watch videos.' : 'Create a free account to watch all videos.'}</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      ${googleConfig() ? googleButton(next || '', 'Continue with Google') : ''}
      <form method="POST" action="/${isLogin ? 'login' : 'register'}" class="form">
        <input type="hidden" name="next" value="${esc(next || '')}">
        ${isLogin ? '' : '<label>Name<input type="text" name="name" required placeholder="Your name"></label>'}
        <label>Email<input type="email" name="email" required placeholder="email@example.com"></label>
        <label>Password<input type="password" name="password" required minlength="6" placeholder="At least 6 characters"></label>
        <button class="btn btn-main btn-big" type="submit">${isLogin ? 'Sign In' : 'Create Account'}</button>
      </form>
      <p class="auth-alt">${isLogin
        ? 'Don\'t have an account? <a href="/register">Sign up</a>'
        : 'Already have an account? <a href="/login">Sign in</a>'}</p>
    </div>
  </section>`;
  return layout(req, { title: isLogin ? 'Sign In' : 'Create Account', body, user: null });
}

app.get('/login', async (req, res) => {
  if (await currentUser(req)) return res.redirect('/');
  res.send(await authPage(req, {
    mode: 'login',
    next: req.query.next || '',
    error: req.query.err ? String(req.query.err).slice(0, 200) : '',
  }));
});
app.get('/register', async (req, res) => {
  if (await currentUser(req)) return res.redirect('/');
  res.send(await authPage(req, { mode: 'register', next: req.query.next || '' }));
});

app.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fail = async (msg) => res.status(400).send(await authPage(req, { mode: 'register', error: msg, next: req.body.next || '' }));
  if (!name) return fail('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
  if (password.length < 6) return fail('Password must be at least 6 characters.');
  if (await queryOne('SELECT id FROM users WHERE email = ?', [email])) return fail('An account with this email already exists — please sign in.');
  const info = await run('INSERT INTO users(name, email, password_hash) VALUES(?, ?, ?)',
    [name, email, hashPassword(password)]);
  await startSession(res, 'session', Number(info.lastInsertRowid), 'user');
  res.redirect('/welcome');
});

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).send(await authPage(req, { mode: 'login', error: 'Wrong email or password.', next: req.body.next || '' }));
  }
  await startSession(res, 'session', u.id, 'user');
  res.redirect(safeNext(req.body.next, '/'));
});

app.post('/logout', async (req, res) => {
  await clearSession(req, res, 'session', 'user');
  res.redirect('/');
});

// Step 1: send the visitor to Google's account chooser.
app.get('/auth/google', (req, res) => {
  const cfg = googleConfig();
  if (!cfg) return res.redirect('/login');
  const state = crypto.randomBytes(16).toString('hex');
  const next = safeNext(req.query.next, '');
  appendSetCookie(res, `${GOOGLE_STATE_COOKIE}=${encodeURIComponent(JSON.stringify({ s: state, n: next }))}; HttpOnly; Path=/; Max-Age=${10 * 60}; SameSite=Lax`);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// Step 2: Google sends the visitor back with a code — trade it for the
// profile, then find-or-create the local account and start a normal session.
app.get('/auth/google/callback', async (req, res) => {
  const cfg = googleConfig();
  if (!cfg) return res.redirect('/login');
  let saved = null;
  try { saved = JSON.parse(parseCookies(req)[GOOGLE_STATE_COOKIE] || 'null'); } catch { saved = null; }
  const savedNext = saved ? safeNext(saved.n, '') : '';
  const clearState = () => appendSetCookie(res, `${GOOGLE_STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  const fail = (msg) => {
    clearState();
    return res.redirect('/login?err=' + encodeURIComponent(msg) + (savedNext ? '&next=' + encodeURIComponent(savedNext) : ''));
  };
  if (req.query.error) return fail("Google sign-in didn't work — please try again.");
  const state = String(req.query.state || '');
  if (!saved || !saved.s || !state || saved.s !== state) {
    return fail("We couldn't verify that sign-in request — please try Google again.");
  }
  const code = String(req.query.code || '');
  if (!code) return fail('No response from Google — please try again.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('token exchange failed');
    const tokenData = await tokenRes.json().catch(() => null);
    const accessToken = tokenData && tokenData.access_token;
    if (!accessToken) throw new Error('no access token');
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!infoRes.ok) throw new Error('userinfo failed');
    const info = await infoRes.json().catch(() => null);
    const email = String((info && info.email) || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('no email from Google');
    // When Google reports the verification flag, it must be true.
    if (info.email_verified !== undefined && info.email_verified !== true && info.email_verified !== 'true') {
      return fail("That Google account's email isn't verified — please try another account.");
    }
    // Find-or-create by email (case-insensitive, matching password signup).
    let user = await queryOne('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
    let isNew = false;
    if (!user) {
      const name = String(info.name || '').trim() || email.split('@')[0];
      const picture = typeof info.picture === 'string' && info.picture.startsWith('https://') ? info.picture : null;
      try {
        // password_hash '' = "no usable password" marker: Google-only
        // accounts simply can never pass verifyPassword (see helper).
        const ins = await run('INSERT INTO users(name, email, password_hash, avatar) VALUES(?, ?, ?, ?)',
          [name, email, '', picture]);
        user = await queryOne('SELECT * FROM users WHERE id = ?', [Number(ins.lastInsertRowid)]);
        isNew = true;
      } catch {
        user = await queryOne('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
        if (!user) throw new Error('user create failed');
      }
    }
    // Adopt the Google picture as avatar only when none is set yet. It is an
    // https: URL — the profile page and header render avatar via <img src>,
    // which accepts both https: URLs and the uploaded data: URLs.
    if (user && !user.avatar && typeof info.picture === 'string' && info.picture.startsWith('https://')) {
      await run('UPDATE users SET avatar = ? WHERE id = ?', [info.picture, user.id]);
    }
    await startSession(res, 'session', user.id, 'user');
    clearState();
    if (isNew) return res.redirect('/welcome');
    return res.redirect(safeNext(savedNext, '/'));
  } catch {
    return fail('Google sign-in failed — please try again, or sign in with your email and password.');
  }
});

app.get('/welcome', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  const ytLinks = await getYoutubeLinks();
  const fbLinks = await getFacebookLinks();
  const logo = await logoSrc();
  const body = `
  <section class="auth-wrap">
    <div class="auth-card welcome-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>Welcome, ${esc(user.name)}!</h1>
      <p class="muted">Your account is ready — you can now watch every video. Join us on YouTube and Facebook too, so new stories reach you first.</p>
      <div class="welcome-btns">
        ${ytLinks.map((l, i) => `<a class="btn btn-youtube btn-big" href="${esc(subscribeUrl(l.url))}" target="_blank" rel="noopener">${socialBtnText('youtube', ytLinks, l, i)}</a>`).join('')}
        ${fbLinks.map((l, i) => `<a class="btn btn-facebook btn-big" href="${esc(l.url)}" target="_blank" rel="noopener">${socialBtnText('facebook', fbLinks, l, i)}</a>`).join('')}
      </div>
      <a class="btn btn-main btn-big" href="/">${ICONS.book}Start Watching</a>
    </div>
  </section>`;
  res.send(await layout(req, { title: 'Welcome', body, user }));
});

// ---------------- watch (login required) ----------------
app.get('/watch/:id', async (req, res) => {
  const user = await currentUser(req);
  const v = await videoRow(Number(req.params.id));
  if (!v) return res.status(404).send(await layout(req, { title: 'Not Found', user, body: '<div class="empty">This video could not be found.</div>' }));
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/watch/' + v.id));
  // Count the view only now: a signed-in viewer actually reached the player.
  await run('UPDATE videos SET views = views + 1 WHERE id = ?', [v.id]);
  const fav = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND video_id = ?', [user.id, v.id]);
  const related = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    WHERE v.category_id IS ? AND v.id != ? ORDER BY v.id DESC LIMIT 6`, [v.category_id, v.id]);
  const comments = await queryAll(`SELECT cm.*, u.name AS user_name, u.avatar AS user_avatar FROM comments cm
    JOIN users u ON u.id = cm.user_id WHERE cm.video_id = ? ORDER BY cm.id DESC`, [v.id]);
  await attachRatings(related);
  const ratingRow = await queryOne('SELECT AVG(stars) AS a, COUNT(*) AS c FROM ratings WHERE video_id = ?', [v.id]);
  const ratingCount = Number(ratingRow.c);
  const ratingAvg = ratingCount ? Number(ratingRow.a) : 0;
  const myRatingRow = await queryOne('SELECT stars FROM ratings WHERE video_id = ? AND user_id = ?', [v.id, user.id]);
  const myRating = myRatingRow ? Number(myRatingRow.stars) : 0;
  // Buttons light up to the viewer's own rating once they have one;
  // before that they preview the rounded average.
  const fillUpTo = myRating || Math.round(ratingAvg);
  const ratingHtml = `
      <div class="rate-block">
        <p class="rate-summary">${ICONS.starSm}<span>${ratingCount ? `${ratingAvg.toFixed(1)} (${ratingCount} rating${ratingCount === 1 ? '' : 's'})` : 'No ratings yet'}</span></p>
        <form method="POST" action="/watch/${v.id}/rate" class="rate-form">
          ${[1, 2, 3, 4, 5].map((n) => `<button class="star-btn${n <= fillUpTo ? ' star-on' : ''}" type="submit" name="stars" value="${n}" title="Rate ${n} star${n === 1 ? '' : 's'}" aria-label="Rate ${n} star${n === 1 ? '' : 's'}">${starIcon(n <= fillUpTo)}</button>`).join('')}
          <span class="rate-hint">${myRating ? `Your rating: ${myRating}/5 — tap a star to change it` : 'Tap a star to rate this video'}</span>
        </form>
      </div>`;
  const commentErr = req.query.err ? `<div class="alert alert-error">${esc(String(req.query.err).slice(0, 200))}</div>` : '';
  // Threaded comments: top-level newest first, each with its replies
  // oldest first so a conversation reads top to bottom. Every signed-in
  // viewer sees the whole thread and can reply (one level deep).
  const topComments = comments.filter((cm) => !cm.parent_id);
  const repliesOf = (pid) => comments.filter((cm) => Number(cm.parent_id) === Number(pid));
  const commentHtml = (cm, isReply) => `<div class="comment${isReply ? ' comment-reply' : ''}">
        ${commentAvatarHtml(cm.user_name, cm.user_avatar)}
        <div class="comment-main">
          <p class="comment-head"><span class="comment-name">${esc(cm.user_name)}</span><span class="comment-time">${relTime(cm.created_at)}</span></p>
          <p class="comment-body">${esc(cm.body).replace(/\r?\n/g, '<br>')}</p>
          <div class="comment-actions">
            ${isReply ? '' : `<button type="button" class="comment-act" data-reply-toggle="${cm.id}">Reply</button>`}
            ${Number(cm.user_id) === Number(user.id) ? `<form method="POST" action="/comments/${cm.id}/delete" class="inlineform"><button class="comment-del" type="submit">Delete</button></form>` : ''}
          </div>
          ${isReply ? '' : `<form method="POST" action="/watch/${v.id}/comments" class="form reply-form" data-reply-form="${cm.id}" hidden>
            <input type="hidden" name="parent_id" value="${cm.id}">
            <textarea name="body" rows="2" maxlength="500" placeholder="Write a reply\u2026" required></textarea>
            <div><button class="btn btn-main btn-sm" type="submit">Post Reply</button></div>
          </form>`}
          ${!isReply && repliesOf(cm.id).length ? `<div class="replies">${repliesOf(cm.id).map((rp) => commentHtml(rp, true)).join('')}</div>` : ''}
        </div>
      </div>`;
  const commentsHtml = `
  <section class="section watch-section" id="comments">
    <h2 class="section-title">Comments (${comments.length})</h2>
    ${commentErr}
    <form method="POST" action="/watch/${v.id}/comments" class="form comment-form">
      <textarea name="body" rows="3" maxlength="500" placeholder="Write a comment\u2026" required></textarea>
      <div><button class="btn btn-main" type="submit">Post Comment</button></div>
    </form>
    ${topComments.length ? `<div class="comments-list">
      ${topComments.map((cm) => commentHtml(cm, false)).join('')}
    </div>` : '<p class="muted">No comments yet \u2014 be the first to share what you think.</p>'}
  </section>`;
  const body = `
  <section class="section watch-section">
    ${backBar()}
    <div class="player">
      ${v.source === 'facebook'
        ? `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(v.source_url || '')}&show_text=false" title="${esc(v.title)}"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
        : `<iframe src="https://www.youtube.com/embed/${esc(v.youtube_id)}" title="${esc(v.title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`}
    </div>
    <div class="watch-head">
      <div>
        <h1>${esc(v.title)}</h1>
        <p class="muted">${v.story ? esc(v.story) + ' • ' : ''}${v.episode ? esc(v.episode) + ' • ' : ''}${v.category_name ? esc(v.category_name) : ''}</p>
        ${ratingHtml}
      </div>
      <form method="POST" action="/favorites/toggle">
        <input type="hidden" name="video_id" value="${v.id}">
        <input type="hidden" name="next" value="/watch/${v.id}">
        <button class="btn ${fav ? 'btn-main' : 'btn-ghost'}" type="submit">${fav ? ICONS.heartFilled + 'Remove from Favorites' : ICONS.heart + 'Add to Favorites'}</button>
      </form>
    </div>
  </section>
  ${commentsHtml}
  ${related.length ? `<section class="section"><h2 class="section-title">More from this category</h2>${grid(related, user)}</section>` : ''}`;
  res.send(await layout(req, { title: v.title, body, user }));
});

// ---------------- ratings ----------------
app.post('/watch/:id/rate', async (req, res) => {
  const user = await currentUser(req);
  const v = await videoRow(Number(req.params.id));
  if (!v) return res.redirect('/');
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/watch/' + v.id));
  const stars = Number(req.body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.redirect(`/watch/${v.id}?err=` + encodeURIComponent('Please pick a rating from 1 to 5 stars.'));
  }
  await run(`INSERT INTO ratings(video_id, user_id, stars) VALUES(?, ?, ?)
    ON CONFLICT(video_id, user_id) DO UPDATE SET stars = excluded.stars`, [v.id, user.id, stars]);
  res.redirect(`/watch/${v.id}`);
});

// ---------------- comments ----------------
app.post('/watch/:id/comments', async (req, res) => {
  const user = await currentUser(req);
  const v = await videoRow(Number(req.params.id));
  if (!v) return res.redirect('/');
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/watch/' + v.id));
  const text = String(req.body.body || '').trim();
  const back = (msg) => res.redirect(`/watch/${v.id}?err=` + encodeURIComponent(msg) + '#comments');
  if (!text) return back('Please write a comment first.');
  if (text.length > 500) return back('Comments can be at most 500 characters long.');
  // A reply must point at a top-level comment on this same video.
  let parentId = null;
  if (req.body.parent_id) {
    const parent = await queryOne('SELECT * FROM comments WHERE id = ?', [Number(req.body.parent_id)]);
    if (!parent || Number(parent.video_id) !== Number(v.id) || parent.parent_id) {
      return back('That comment is no longer available to reply to.');
    }
    parentId = parent.id;
  }
  await run('INSERT INTO comments(video_id, user_id, body, parent_id) VALUES(?, ?, ?, ?)', [v.id, user.id, text, parentId]);
  res.redirect(`/watch/${v.id}#comments`);
});

// Only the comment's own author may delete it (checked server-side).
app.post('/comments/:id/delete', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  const cm = await queryOne('SELECT * FROM comments WHERE id = ?', [Number(req.params.id)]);
  if (!cm) return res.redirect('/');
  if (Number(cm.user_id) === Number(user.id)) {
    await run('DELETE FROM comments WHERE id = ? OR parent_id = ?', [cm.id, cm.id]);
  }
  res.redirect(`/watch/${cm.video_id}#comments`);
});

// ---------------- notifications ----------------
app.get('/notifications', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/notifications'));
  const watermark = Number(user.last_seen_notif || 0);
  const notifs = await queryAll(`SELECT n.id AS notif_id, n.created_at AS notif_at, v.id AS video_id,
      v.title, v.story, v.episode, v.source, v.youtube_id, v.source_url
    FROM notifications n JOIN videos v ON v.id = n.video_id
    ORDER BY n.id DESC LIMIT 30`);
  const maxRow = await queryOne('SELECT COALESCE(MAX(id), 0) AS m FROM notifications');
  const body = `
  <section class="section">
    ${backBar()}
    <h2 class="section-title">${ICONS.bell}Notifications</h2>
    ${notifs.length ? `<div class="notif-list">
      ${notifs.map((n) => {
        const fresh = Number(n.notif_id) > watermark;
        return `<a class="notif-row${fresh ? ' notif-unread' : ''}" href="/watch/${n.video_id}">
        <img class="notif-thumb" src="${cardThumb(n)}" alt="">
        <span class="notif-main">
          <span class="notif-label">New video added${fresh ? ' <span class="notif-pill">New</span>' : ''}</span>
          <span class="notif-title">${esc(n.title)}</span>
          ${n.story || n.episode ? `<span class="notif-sub">${esc([n.story, n.episode].filter(Boolean).join(' • '))}</span>` : ''}
        </span>
        <span class="notif-time">${relTime(n.notif_at)}</span>
      </a>`;
      }).join('')}
    </div>` : `<div class="empty"><span class="empty-book">${ICONS.bell}</span>No notifications yet — new videos will appear here.</div>`}
  </section>`;
  res.send(await layout(req, { title: 'Notifications', body, user }));
  // Mark all as read only AFTER the page above was rendered from the old
  // watermark, so the New pills show on this visit and the header badge
  // clears from the next page load onwards.
  if (Number(maxRow.m) > watermark) {
    await run('UPDATE users SET last_seen_notif = ? WHERE id = ?', [Number(maxRow.m), user.id]);
  }
});

// ---------------- user pages ----------------
app.post('/favorites/toggle', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  const videoId = Number(req.body.video_id);
  if (await videoRow(videoId)) {
    const fav = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND video_id = ?', [user.id, videoId]);
    if (fav) await run('DELETE FROM favorites WHERE user_id = ? AND video_id = ?', [user.id, videoId]);
    else await run('INSERT INTO favorites(user_id, video_id) VALUES(?, ?)', [user.id, videoId]);
  }
  res.redirect(safeNext(req.body.next, '/favorites'));
});

app.get('/favorites', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/favorites'));
  const videos = await queryAll(`SELECT v.*, c.name AS category_name FROM favorites f
    JOIN videos v ON v.id = f.video_id LEFT JOIN categories c ON c.id = v.category_id
    WHERE f.user_id = ? ORDER BY f.created_at DESC`, [user.id]);
  await attachRatings(videos);
  const body = `
  <section class="section">
    ${backBar()}
    <h2 class="section-title">${ICONS.heart}My Favorites</h2>
    ${videos.length ? grid(videos, user) : '<div class="empty">Your favorites list is empty — tap the heart button while watching a video and it will show up here.</div>'}
  </section>`;
  res.send(await layout(req, { title: 'My Favorites', body, user }));
});

app.get('/profile', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/profile'));
  const favCount = (await queryOne('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?', [user.id])).c;
  const logo = await logoSrc();
  const body = `
  <div class="page-top">${backBar()}</div>
  <section class="auth-wrap">
    <div class="auth-card">
      <img id="profileAvatarImg" class="auth-logo profile-avatar" src="${user.avatar ? esc(user.avatar) : logo}" alt="Profile photo">
      <h1>My Profile</h1>
      <div class="avatar-upload">
        <input type="file" id="avatarInput" accept="image/*" hidden>
        <label class="btn btn-ghost" for="avatarInput">${ICONS.camera}Change profile photo</label>
        <button type="button" id="avatarSave" class="btn btn-main" disabled>Save photo</button>
        <p id="avatarMsg" class="avatar-msg" role="status"></p>
      </div>
      <table class="profile-table">
        <tr><th>Name</th><td>${esc(user.name)}</td></tr>
        <tr><th>Email</th><td>${esc(user.email)}</td></tr>
        <tr><th>Joined</th><td>${esc(String(user.created_at).slice(0, 10))}</td></tr>
        <tr><th>Favorite videos</th><td>${favCount}</td></tr>
      </table>
      <a class="btn btn-main btn-big" href="/favorites">${ICONS.heart}View Favorites</a>
      <form method="POST" action="/logout" class="form"><button class="btn btn-ghost btn-big" type="submit">Logout</button></form>
    </div>
  </section>`;
  res.send(await layout(req, { title: 'My Profile', body, user }));
});

// Profile picture: the browser downscales the image and sends a small JPEG data URL.
app.post('/profile/avatar', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please sign in first.' });
  const avatar = req.body && req.body.avatar;
  if (typeof avatar !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(avatar)) {
    return res.status(400).json({ ok: false, error: "That's not an image — please choose a JPG/PNG photo." });
  }
  if (avatar.length > 250 * 1024) {
    return res.status(413).json({ ok: false, error: 'That photo is too large — please pick a smaller one.' });
  }
  await run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, user.id]);
  res.json({ ok: true });
});

// ---------------- admin ----------------
async function requireAdminPage(req, res) {
  if (!(await getSetting('admin_password_hash'))) return false; // handled by setup flow
  if (!(await isAdmin(req))) { res.redirect('/admin'); return false; }
  return true;
}

app.get('/admin', async (req, res) => {
  const logo = await logoSrc();
  if (!(await getSetting('admin_password_hash'))) {
    return res.send(await adminLayout({ title: 'First Setup', bare: true, body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>${ICONS.lock}Create the Admin Password</h1>
      <p class="muted">This is the first run — choose an admin password for yourself. You will use it to sign in to the admin panel from now on.</p>
      <form method="POST" action="/admin/setup" class="form">
        <label>New Password<input type="password" name="password" required minlength="6"></label>
        <label>Type It Again<input type="password" name="confirm" required minlength="6"></label>
        <button class="btn btn-main btn-big" type="submit">Set Password</button>
      </form>
    </div></section>` }));
  }
  if (!(await isAdmin(req))) {
    const err = req.query.err ? '<div class="alert alert-error">That password is wrong — please try again.</div>' : '';
    return res.send(await adminLayout({ title: 'Admin Login', bare: true, body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>${ICONS.lock}Admin Login</h1>
      ${err}
      <form method="POST" action="/admin/login" class="form">
        <label>Admin Password<input type="password" name="password" required></label>
        <button class="btn btn-main btn-big" type="submit">Log In</button>
      </form>
    </div></section>` }));
  }
  const userCount = (await queryOne('SELECT COUNT(*) AS c FROM users')).c;
  const videoCount = (await queryOne('SELECT COUNT(*) AS c FROM videos')).c;
  const catCount = (await queryOne('SELECT COUNT(*) AS c FROM categories')).c;
  res.send(await adminLayout({ title: 'Dashboard', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.grid}Dashboard</h2>
    <div class="statgrid">
      <div class="stat stat-glow accent-gold">
        <span class="stat-ic">${ICONS.users}</span>
        <span class="stat-meta"><strong>${Number(userCount)}</strong><span>Registered Users</span></span>
        <span class="stat-wm" aria-hidden="true">${ICONS.users}</span>
      </div>
      <div class="stat stat-glow accent-purple">
        <span class="stat-ic">${ICONS.play}</span>
        <span class="stat-meta"><strong>${Number(videoCount)}</strong><span>Total Videos</span></span>
        <span class="stat-wm" aria-hidden="true">${ICONS.play}</span>
      </div>
      <div class="stat stat-glow accent-green">
        <span class="stat-ic">${ICONS.layers}</span>
        <span class="stat-meta"><strong>${Number(catCount)}</strong><span>Categories</span></span>
        <span class="stat-wm" aria-hidden="true">${ICONS.layers}</span>
      </div>
    </div>
    <div class="quicklinks">
      <a class="btn btn-main qa-primary" href="/admin/videos">${ICONS.plus}<span>Add a New Video</span>${ICONS.chevronRight}</a>
      <a class="btn btn-ghost qa-purple" href="/admin/categories">${ICONS.folder}<span>Organize Categories</span>${ICONS.chevronRight}</a>
      <a class="btn btn-ghost qa-wide" href="/admin/settings">${ICONS.link}<span>Change Site Name / Logo / Links</span>${ICONS.chevronRight}</a>
    </div>
  </section>` }));
});

app.post('/admin/setup', async (req, res) => {
  if (await getSetting('admin_password_hash')) return res.redirect('/admin');
  const pw = String(req.body.password || '');
  if (pw.length < 6 || pw !== String(req.body.confirm || '')) return res.redirect('/admin');
  await setSetting('admin_password_hash', hashPassword(pw));
  await startSession(res, 'admin_session', null, 'admin');
  res.redirect('/admin');
});

app.post('/admin/login', async (req, res) => {
  const hash = await getSetting('admin_password_hash');
  if (!hash || !verifyPassword(String(req.body.password || ''), hash)) return res.redirect('/admin?err=1');
  await startSession(res, 'admin_session', null, 'admin');
  res.redirect('/admin');
});

app.post('/admin/logout', async (req, res) => {
  await clearSession(req, res, 'admin_session', 'admin');
  res.redirect('/admin');
});

app.get('/admin/videos', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const err = req.query.err ? `<div class="alert alert-error">${esc(req.query.err)}</div>` : '';
  const ytKeySet = !!String(process.env.YOUTUBE_API_KEY || '').trim();
  const cats = await allCategories();
  const videos = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC`);
  const catOptions = (sel) => cats.map((c) => `<option value="${c.id}" ${Number(sel) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  res.send(await adminLayout({ title: 'Videos', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.plusCircle}Add a New Video</h2>
    ${err}
    <form method="POST" action="/admin/videos" class="form panel">
      <label>Video Link (YouTube or Facebook)<input type="text" name="link" required placeholder="Paste a YouTube or Facebook video link…"></label>
      <p class="muted">Facebook videos must be public (e.g. on a Page) to play here.</p>
      <label>Video Title<input type="text" name="title" required placeholder="e.g. The Black River"></label>
      <label>Story / Series Name<input type="text" name="story" placeholder="e.g. AGNIBRITTA"></label>
      <label>Episode<input type="text" name="episode" placeholder="e.g. Season 1 • Chapter 01"></label>
      <label>Synopsis (a short summary)<textarea name="synopsis" rows="3" placeholder="Two or three lines about the story — if this video is featured, it shows in the homepage hero banner"></textarea></label>
      <label>Category<select name="category_id">${catOptions('')}</select></label>
      <label class="checklabel"><input type="checkbox" name="featured" value="1"> Featured — pin this video in the big hero banner on the homepage (only one at a time). If none is featured, the hero automatically shows the Top 1 video</label>
      <button class="btn btn-main" type="submit">Add Video</button>
    </form>
    ${ytKeySet
      ? '<form method="POST" action="/admin/refresh-yt-views" class="yt-refresh"><button class="btn btn-ghost" type="submit">Refresh YouTube views</button></form>'
      : '<p class="muted yt-refresh">YouTube API key not set</p>'}
    <h2 class="section-title">${ICONS.playRect}All Videos (${videos.length})</h2>
    ${videos.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>Thumbnail</th><th>Title</th><th>Story / Episode</th><th>Category</th><th>Views</th><th></th></tr>
      ${videos.map((v) => `<tr>
        <td><img class="mini-thumb" src="${v.source === 'facebook' ? '/banner.jpg' : `https://i.ytimg.com/vi/${esc(v.youtube_id)}/default.jpg`}" alt=""></td>
        <td>${esc(v.title)}${v.featured ? ' <span class="feat-badge">Featured</span>' : ''} <span class="src-badge">${v.source === 'facebook' ? 'Facebook' : 'YouTube'}</span></td>
        <td>${esc(v.story)} ${v.episode ? '• ' + esc(v.episode) : ''}</td>
        <td>${esc(v.category_name || '—')}</td>
        <td>${Number(v.views || 0) + Number(v.yt_views || 0)}</td>
        <td class="rowbtns">
          <a class="btn btn-ghost btn-sm" href="/admin/videos/${v.id}/edit">Edit</a>
          <form method="POST" action="/admin/videos/${v.id}/delete" data-confirm="Delete this video?"><button class="btn btn-danger btn-sm" type="submit">Delete</button></form>
        </td></tr>`).join('')}
    </table></div>` : '<div class="empty">No videos yet.</div>'}
  </section>` }));
});

app.post('/admin/videos', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const parsed = parseVideoLink(req.body.link);
  if (!parsed) return res.redirect('/admin/videos?err=' + encodeURIComponent(VIDEO_LINK_ERROR));
  const featured = req.body.featured ? 1 : 0;
  if (featured) await run('UPDATE videos SET featured = 0');
  const info = await run('INSERT INTO videos(youtube_id, title, story, episode, synopsis, featured, category_id, source, source_url) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [parsed.youtubeId, String(req.body.title || '').trim() || 'Untitled', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      Number(req.body.category_id) || null, parsed.source, parsed.url]);
  // A brand-new upload notifies every user (badge + /notifications page).
  // Edits deliberately do not create a notification.
  if (info.lastInsertRowid) await run('INSERT INTO notifications(video_id) VALUES(?)', [Number(info.lastInsertRowid)]);
  res.redirect('/admin/videos');
});

app.post('/admin/refresh-yt-views', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  await refreshYtViews(); // fail-soft: old counts stay when the API is unreachable
  res.redirect('/admin/videos');
});

app.get('/admin/videos/:id/edit', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const v = await videoRow(Number(req.params.id));
  if (!v) return res.redirect('/admin/videos');
  const err = req.query.err ? `<div class="alert alert-error">${esc(req.query.err)}</div>` : '';
  const cats = await allCategories();
  res.send(await adminLayout({ title: 'Edit Video', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.pencil}Edit Video</h2>
    ${err}
    <form method="POST" action="/admin/videos/${v.id}/edit" class="form panel">
      <label>Video Link (YouTube or Facebook)<input type="text" name="link" required value="${esc(v.source === 'facebook' ? (v.source_url || '') : 'https://www.youtube.com/watch?v=' + v.youtube_id)}"></label>
      <p class="muted">Facebook videos must be public (e.g. on a Page) to play here.</p>
      <label>Video Title<input type="text" name="title" required value="${esc(v.title)}"></label>
      <label>Story / Series Name<input type="text" name="story" value="${esc(v.story)}"></label>
      <label>Episode<input type="text" name="episode" value="${esc(v.episode)}"></label>
      <label>Synopsis (a short summary)<textarea name="synopsis" rows="3" placeholder="Two or three lines about the story…">${esc(v.synopsis || '')}</textarea></label>
      <label>Category<select name="category_id">${cats.map((c) => `<option value="${c.id}" ${v.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="checklabel"><input type="checkbox" name="featured" value="1" ${v.featured ? 'checked' : ''}> Featured — pin this video in the big hero banner on the homepage (only one at a time). If none is featured, the hero automatically shows the Top 1 video</label>
      <button class="btn btn-main" type="submit">Save</button>
      <a class="btn btn-ghost" href="/admin/videos">Back</a>
    </form>
  </section>` }));
});

app.post('/admin/videos/:id/edit', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const id = Number(req.params.id);
  const parsed = parseVideoLink(req.body.link);
  if (!parsed) return res.redirect(`/admin/videos/${id}/edit?err=` + encodeURIComponent(VIDEO_LINK_ERROR));
  const featured = req.body.featured ? 1 : 0;
  if (featured) await run('UPDATE videos SET featured = 0 WHERE id != ?', [id]);
  await run('UPDATE videos SET youtube_id = ?, title = ?, story = ?, episode = ?, synopsis = ?, featured = ?, category_id = ?, source = ?, source_url = ? WHERE id = ?',
    [parsed.youtubeId, String(req.body.title || '').trim() || 'Untitled', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      Number(req.body.category_id) || null, parsed.source, parsed.url, id]);
  res.redirect('/admin/videos');
});

app.post('/admin/videos/:id/delete', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const id = Number(req.params.id);
  await run('DELETE FROM favorites WHERE video_id = ?', [id]);
  await run('DELETE FROM comments WHERE video_id = ?', [id]);
  await run('DELETE FROM notifications WHERE video_id = ?', [id]);
  await run('DELETE FROM ratings WHERE video_id = ?', [id]);
  await run('DELETE FROM videos WHERE id = ?', [id]);
  res.redirect('/admin/videos');
});

app.get('/admin/categories', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const cats = await allCategories();
  res.send(await adminLayout({ title: 'Categories', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.plusCircle}Add a New Category</h2>
    <form method="POST" action="/admin/categories" class="form panel inline-add">
      <input type="text" name="name" required placeholder="Category name">
      <button class="btn btn-main" type="submit">Add</button>
    </form>
    <h2 class="section-title">${ICONS.layers}All Categories (${cats.length})</h2>
    <div class="tablewrap"><table class="admintable">
      <tr><th>Name</th><th>Videos</th><th></th></tr>
      ${cats.map((c) => `<tr>
        <td>
          <form method="POST" action="/admin/categories/${c.id}/rename" class="rename-form">
            <input type="text" name="name" value="${esc(c.name)}" required>
            <button class="btn btn-ghost btn-sm" type="submit">Rename</button>
          </form>
        </td>
        <td>${Number(c.video_count)}</td>
        <td><form method="POST" action="/admin/categories/${c.id}/delete" data-confirm="Delete this category? Its videos will be left without a category."><button class="btn btn-danger btn-sm" type="submit">Delete</button></form></td>
      </tr>`).join('')}
    </table></div>
  </section>` }));
});

app.post('/admin/categories', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const name = String(req.body.name || '').trim();
  if (name) {
    const max = (await queryOne('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories')).m;
    await run('INSERT INTO categories(name, sort_order) VALUES(?, ?)', [name, max + 1]);
  }
  res.redirect('/admin/categories');
});

app.post('/admin/categories/:id/rename', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const name = String(req.body.name || '').trim();
  if (name) await run('UPDATE categories SET name = ? WHERE id = ?', [name, Number(req.params.id)]);
  res.redirect('/admin/categories');
});

app.post('/admin/categories/:id/delete', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const id = Number(req.params.id);
  await run('UPDATE videos SET category_id = NULL WHERE category_id = ?', [id]);
  await run('DELETE FROM categories WHERE id = ?', [id]);
  res.redirect('/admin/categories');
});

app.get('/admin/users', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const users = await queryAll('SELECT * FROM users ORDER BY id DESC');
  res.send(await adminLayout({ title: 'Users', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.users}Registered Users — ${users.length} in total</h2>
    ${users.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>#</th><th>Name</th><th>Email</th><th>Joined</th></tr>
      ${users.map((u) => `<tr><td>${Number(u.id)}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(String(u.created_at).slice(0, 10))}</td></tr>`).join('')}
    </table></div>` : '<div class="empty">No one has created an account yet.</div>'}
  </section>` }));
});

app.get('/admin/comments', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const comments = await queryAll(`SELECT cm.*, u.name AS user_name, v.title AS video_title FROM comments cm
    JOIN users u ON u.id = cm.user_id JOIN videos v ON v.id = cm.video_id
    ORDER BY cm.id DESC LIMIT 100`);
  res.send(await adminLayout({ title: 'Comments', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.layers}Comments — ${comments.length} latest</h2>
    ${comments.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>Commenter</th><th>Video</th><th>Comment</th><th>Date</th><th></th></tr>
      ${comments.map((cm) => `<tr>
        <td>${esc(cm.user_name)}</td>
        <td><a href="/watch/${cm.video_id}" target="_blank" rel="noopener">${esc(cm.video_title)}</a></td>
        <td>${cm.parent_id ? '<em class="muted">(Reply) </em>' : ''}${esc(truncate(cm.body, 120))}</td>
        <td>${esc(String(cm.created_at).slice(0, 10))}</td>
        <td><form method="POST" action="/admin/comments/${cm.id}/delete" data-confirm="Delete this comment?"><button class="btn btn-danger btn-sm" type="submit">Delete</button></form></td>
      </tr>`).join('')}
    </table></div>` : '<div class="empty">No comments yet.</div>'}
  </section>` }));
});

app.post('/admin/comments/:id/delete', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const cid = Number(req.params.id);
  await run('DELETE FROM comments WHERE id = ? OR parent_id = ?', [cid, cid]);
  res.redirect('/admin/comments');
});

app.get('/admin/settings', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const msg = req.query.ok ? '<div class="alert alert-ok">Saved</div>' : '';
  const err = req.query.err ? `<div class="alert alert-error">${esc(req.query.err)}</div>` : '';
  const name = await siteName();
  const logo = await logoSrc();
  const ytLinks = await getYoutubeLinks();
  const fbLinks = await getFacebookLinks();
  const linkRowHtml = (platform, item) => `
        <div class="linkrow" data-linkrow>
          <input type="text" class="linkrow-label" name="${platform}_label" value="${esc(item ? item.label : '')}" placeholder="Name (optional)" maxlength="60">
          <input type="text" class="linkrow-url" name="${platform}_url" value="${esc(item ? item.url : '')}" placeholder="${platform === 'youtube' ? 'https://www.youtube.com/@YourChannel' : 'https://www.facebook.com/YourPage'}">
          <button type="button" class="btn btn-danger btn-sm" data-remove-link>Remove</button>
        </div>`;
  const linkGroupHtml = (platform, title, addText, links) => `
      <div class="linkgroup">
        <span class="linkgroup-title">${title}</span>
        <div class="linkrows" data-linkrows="${platform}">
          ${links.map((l) => linkRowHtml(platform, l)).join('')}
        </div>
        <template data-linktemplate="${platform}">${linkRowHtml(platform, null)}</template>
        <div><button type="button" class="btn btn-ghost btn-sm" data-add-link="${platform}">${addText}</button></div>
      </div>`;
  res.send(await adminLayout({ title: 'Settings', body: `
  <section class="section">
    <h2 class="section-title">${ICONS.gear}Settings</h2>
    ${msg}${err}
    <form method="POST" action="/admin/settings" class="form panel">
      <label>Site Name<input type="text" name="site_name" value="${esc(name)}" required></label>
      ${linkGroupHtml('youtube', 'YouTube Channel Links', '+ Add Another YouTube Channel', ytLinks)}
      ${linkGroupHtml('facebook', 'Facebook Page Links', '+ Add Another Facebook Page', fbLinks)}
      <button class="btn btn-main" type="submit">Save</button>
      <p class="muted">One link per row; if you give a link a name, the button will show that name; leave a row empty and that link will not be shown.</p>
    </form>
    <h2 class="section-title">${ICONS.image}Site Logo</h2>
    <div class="panel">
      <p>Current logo:</p>
      <img class="logo-preview" src="${logo}" alt="">
      <form method="POST" action="/admin/logo" enctype="multipart/form-data" class="form">
        <label>New logo image (PNG/JPG/WebP, max 3MB)<input type="file" name="logo" accept="image/*" required></label>
        <button class="btn btn-main" type="submit">Upload Logo</button>
      </form>
      <form method="POST" action="/admin/logo/reset" data-confirm="Return to the default logo?">
        <button class="btn btn-ghost" type="submit">Return to Default Logo</button>
      </form>
    </div>
    <h2 class="section-title">${ICONS.key}Change Admin Password</h2>
    <form method="POST" action="/admin/settings/password" class="form panel">
      <label>Current Password<input type="password" name="current" required></label>
      <label>New Password<input type="password" name="next" required minlength="6"></label>
      <button class="btn btn-main" type="submit">Change Password</button>
    </form>
  </section>` }));
});

app.post('/admin/settings', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  await setSetting('site_name', String(req.body.site_name || '').trim() || 'Stories Come Alive');
  const ytLinks = linkListFromForm(req.body.youtube_label, req.body.youtube_url);
  const fbLinks = linkListFromForm(req.body.facebook_label, req.body.facebook_url);
  await setSetting('youtube_links', JSON.stringify(ytLinks));
  await setSetting('facebook_links', JSON.stringify(fbLinks));
  // Keep the legacy single-link keys in sync (first link wins) for consistency.
  await setSetting('youtube_url', ytLinks.length ? ytLinks[0].url : '');
  await setSetting('facebook_url', fbLinks.length ? fbLinks[0].url : '');
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/settings/password', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const hash = await getSetting('admin_password_hash');
  if (!verifyPassword(String(req.body.current || ''), hash)) {
    return res.redirect('/admin/settings?err=' + encodeURIComponent('The current password is wrong.'));
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.redirect('/admin/settings?err=' + encodeURIComponent('The new password must be at least 6 characters long.'));
  await setSetting('admin_password_hash', hashPassword(next));
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/logo', upload.single('logo'), async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  if (!req.file) return res.redirect('/admin/settings?err=' + encodeURIComponent('No image was received.'));
  await setAsset('logo', req.file.mimetype, req.file.buffer);
  await setSetting('logo_version', String(Date.now()));
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/logo/reset', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  await deleteAsset('logo');
  await setSetting('logo_version', String(Date.now()));
  res.redirect('/admin/settings?ok=1');
});

// upload errors (e.g. wrong file type / too big)
app.use((err, req, res, next) => {
  if (err) return res.redirect('/admin/settings?err=' + encodeURIComponent('Upload failed: ' + (err.message || 'invalid file')));
  next();
});

app.use(async (req, res) => {
  const user = await currentUser(req);
  res.status(404).send(await layout(req, { title: 'Not Found', user, body: '<div class="empty">Sorry, this page does not exist. <a href="/">Go home</a></div>' }));
});

// Wait for the data layer (schema, migrations, seeds) before accepting traffic.
ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Stories Come Alive — library running on port ${PORT} (db: ${DB_TARGET})`);
  });
}).catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
