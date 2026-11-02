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
    else cb(new Error('শুধু ছবির ফাইল (PNG/JPG/WebP/GIF/SVG) দেওয়া যাবে।'));
  },
});

// ---------------- helpers ----------------
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toBn(n) {
  return String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
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
function subscribeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  // For channel/handle URLs, jump straight to YouTube's subscribe-confirm screen.
  if (/youtube\.com\/(channel\/|@|c\/|user\/)/.test(u) && !u.includes('?')) return u + '?sub_confirmation=1';
  return u;
}
async function siteName() { return (await getSetting('site_name')) || 'Stories Come Alive'; }
async function logoSrc() { return '/brand/logo?v=' + ((await getSetting('logo_version')) || '0'); }
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
// Top-list rank from the admin form: a positive whole number, or null when
// the field is left empty/invalid (null = not in the Top Picks list).
function parseRank(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// Obvious way back / home for inner user pages (profile, favorites, watch).
function backBar() {
  return `<nav class="backbar">
    <button type="button" class="btn btn-ghost btn-sm" data-back>← Back</button>
    <a class="btn btn-ghost btn-sm" href="/">🏠 Home</a>
  </nav>`;
}

// ---------------- layout ----------------
async function layout(req, { title, body, user }) {
  const name = await siteName();
  const logo = await logoSrc();
  const yt = await getSetting('youtube_url');
  const fb = await getSetting('facebook_url');
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? title + ' — ' + name : name)}</title>
<link rel="icon" href="/brand/logo">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <img class="brand-logo" src="${logo}" alt="${esc(name)}">
    <span class="brand-name">${esc(name)}</span>
  </a>
  <div class="userbox">
    ${user
      ? `<a class="navlink" href="/favorites">❤️ Favorites</a>
         <a class="navlink" href="/profile">${user.avatar ? `<img class="nav-avatar" src="${esc(user.avatar)}" alt="">` : '👤'} Profile</a>
         <form method="POST" action="/logout" class="inlineform"><button class="btn btn-ghost btn-sm" type="submit">Logout</button></form>`
      : `<a class="btn btn-main signin-btn" href="/login">Sign In</a>`}
  </div>
</header>
<main>
${body}
</main>
<footer class="footer">
  <div class="footer-brand"><img src="${logo}" alt=""><span>${esc(name)}</span></div>
  ${(yt || fb) ? '<p class="footer-follow">FOLLOW US</p>' : ''}
  <div class="footer-links">
    ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener">▶️ YouTube</a>` : ''}
    ${fb ? `<a href="${esc(fb)}" target="_blank" rel="noopener">📘 Facebook</a>` : ''}
    <a href="/privacy-policy">Privacy Policy</a>
    <a href="/admin">Admin</a>
  </div>
  <p class="footer-copy">© ${new Date().getFullYear()} ${esc(name)} — All rights reserved.</p>
</footer>
<script src="/app.js"></script>
</body>
</html>`;
}

async function adminLayout({ title, body }) {
  const name = await siteName();
  const logo = await logoSrc();
  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — অ্যাডমিন — ${esc(name)}</title>
<link rel="icon" href="/brand/logo">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin">
    <img class="brand-logo" src="${logo}" alt="">
    <span class="brand-name">${esc(name)} — অ্যাডমিন</span>
  </a>
  <nav class="mainnav">
    <a class="navlink" href="/admin">ড্যাশবোর্ড</a>
    <a class="navlink" href="/admin/videos">ভিডিও</a>
    <a class="navlink" href="/admin/categories">ক্যাটাগরি</a>
    <a class="navlink" href="/admin/users">ব্যবহারকারী</a>
    <a class="navlink" href="/admin/settings">সেটিংস</a>
    <a class="navlink" href="/" target="_blank">সাইট দেখুন ↗</a>
  </nav>
  <form method="POST" action="/admin/logout" class="inlineform"><button class="btn btn-ghost" type="submit">লগআউট</button></form>
</header>
<main>
${body}
</main>
<script src="/app.js"></script>
</body>
</html>`;
}

function videoCard(v, user) {
  return `<a class="card" href="/watch/${v.id}">
    <div class="thumb">
      <img loading="lazy" src="https://i.ytimg.com/vi/${esc(v.youtube_id)}/hqdefault.jpg" alt="${esc(v.title)}">
      ${v.rank ? `<span class="rank-chip">#${Number(v.rank)}</span>` : ''}
      ${v.episode ? `<span class="ep-badge">${esc(v.episode)}</span>` : ''}
      <span class="play-badge">▶</span>
    </div>
    <div class="card-body">
      <h3>${esc(v.title)}</h3>
      ${v.story ? `<p class="card-story">${esc(v.story)}</p>` : ''}
      ${v.category_name ? `<p class="card-cat">${esc(v.category_name)}</p>` : ''}
      ${user ? '' : '<p class="card-lock">🔒 Sign in to watch</p>'}
    </div>
  </a>`;
}
function grid(videos, user) {
  if (!videos.length) return '<div class="empty">No videos yet — coming soon!</div>';
  return `<div class="grid">${videos.map((v) => videoCard(v, user)).join('')}</div>`;
}

// Horizontally scrollable poster-card row (bhoot-style homepage rows).
function posterRow({ title, videos, user, moreHref }) {
  if (!videos.length) return '';
  return `<section class="section rowsection">
    <div class="rowhead">
      <h2 class="section-title">${title}</h2>
      ${moreHref ? `<a class="rowmore" href="${moreHref}">View All →</a>` : ''}
    </div>
    <div class="rowwrap">
      <div class="rowscroll">${videos.map((v) => videoCard(v, user)).join('')}</div>
      <button class="rowbtn rowbtn-prev" type="button" data-scroll="prev" aria-label="Previous videos">‹</button>
      <button class="rowbtn rowbtn-next" type="button" data-scroll="next" aria-label="More videos">›</button>
    </div>
  </section>`;
}
function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
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
  const user = await currentUser(req);
  const name = await siteName();
  const featured = await queryOne(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.featured = 1 ORDER BY v.id DESC LIMIT 1`);
  const topPicks = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.rank IS NOT NULL AND v.rank > 0 ORDER BY v.rank ASC, v.id DESC LIMIT 20`);
  const latest = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC LIMIT 12`);

  let hero;
  if (featured) {
    hero = `
  <section class="fhero">
    <img class="fhero-img" src="https://i.ytimg.com/vi/${esc(featured.youtube_id)}/maxresdefault.jpg"
      onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${esc(featured.youtube_id)}/hqdefault.jpg'" alt="${esc(featured.title)}">
    <div class="fhero-shade"></div>
    <div class="fhero-content">
      ${featured.rank ? `<span class="fhero-topbadge">Top ${Number(featured.rank)}</span>` : ''}
      ${featured.category_name ? `<span class="fhero-badge">${esc(featured.category_name)}</span>` : ''}
      <h1 class="fhero-title">${esc(featured.title)}</h1>
      ${featured.story ? `<p class="fhero-story">${esc(featured.story)}${featured.episode ? ' • ' + esc(featured.episode) : ''}</p>` : ''}
      ${featured.synopsis ? `<p class="fhero-syn" data-syn>${esc(featured.synopsis)}</p>${String(featured.synopsis).trim().length > 160 ? '<button type="button" class="syn-toggle" data-syn-toggle>Read More</button>' : ''}` : ''}
      <a class="btn btn-main fhero-btn" href="/watch/${featured.id}">▶ Watch Now</a>
      ${user ? '' : '<p class="fhero-note">Sign in to watch — new here? Create a free account.</p>'}
    </div>
  </section>`;
  } else {
    hero = `
  <section class="hero">
    <img class="hero-art" src="/banner.jpg" alt="${esc(name)}">
    <div class="hero-overlay">
      <h1 class="sr-only">${esc(name)}</h1>
      <p>A library of story videos, sorted by category — pick a story and start watching.</p>
      <form class="searchbar" method="GET" action="/search">
        <input type="text" name="q" placeholder="Search stories…">
        <button class="btn btn-main" type="submit">Search</button>
      </form>
      ${user ? '' : '<p class="hero-note"><a href="/login">Sign in</a> to watch, or <a href="/register">create a free account</a>.</p>'}
    </div>
  </section>`;
  }

  let rows = '';
  if (topPicks.length) rows += posterRow({ title: 'Top Picks', videos: topPicks, user });
  rows += posterRow({ title: 'Latest Stories', videos: latest, user });
  for (const c of await allCategories()) {
    if (!c.video_count) continue;
    const vids = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC LIMIT 12`, [c.id]);
    rows += posterRow({ title: esc(c.name), videos: vids, user, moreHref: `/category/${c.id}` });
  }
  if (!latest.length) {
    rows = `<section class="section"><div class="empty">No videos yet — coming soon!</div></section>`;
  }
  res.send(await layout(req, { title: '', body: hero + rows, user }));
});

app.get('/category/:id', async (req, res) => {
  const user = await currentUser(req);
  const cat = await queryOne('SELECT * FROM categories WHERE id = ?', [Number(req.params.id)]);
  if (!cat) return res.status(404).send(await layout(req, { title: 'Not Found', user, body: '<div class="empty">This category could not be found.</div>' }));
  const videos = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC`, [cat.id]);
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
  const body = `
  <section class="section">
    <h2 class="section-title">🔎 Search results</h2>
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
    <p>If you have any question about your privacy, or you would like your account and its data deleted, please email us at <a href="mailto:abirhasan221717@gmail.com">abirhasan221717@gmail.com</a> and we will take care of it.</p>
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
  const yt = subscribeUrl(await getSetting('youtube_url'));
  const fb = String((await getSetting('facebook_url')) || '').trim();
  const logo = await logoSrc();
  const body = `
  <section class="auth-wrap">
    <div class="auth-card welcome-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>Welcome, ${esc(user.name)}! 🎉</h1>
      <p class="muted">Your account is ready — you can now watch every video. Join us on YouTube and Facebook too, so new stories reach you first.</p>
      <div class="welcome-btns">
        ${yt ? `<a class="btn btn-youtube btn-big" href="${esc(yt)}" target="_blank" rel="noopener">▶️ Subscribe on YouTube</a>` : ''}
        ${fb ? `<a class="btn btn-facebook btn-big" href="${esc(fb)}" target="_blank" rel="noopener">📘 Follow on Facebook</a>` : ''}
      </div>
      <a class="btn btn-main btn-big" href="/">📚 Start Watching</a>
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
  const fav = await queryOne('SELECT 1 AS x FROM favorites WHERE user_id = ? AND video_id = ?', [user.id, v.id]);
  const related = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    WHERE v.category_id IS ? AND v.id != ? ORDER BY v.id DESC LIMIT 6`, [v.category_id, v.id]);
  const body = `
  <section class="section watch-section">
    ${backBar()}
    <div class="player">
      <iframe src="https://www.youtube.com/embed/${esc(v.youtube_id)}" title="${esc(v.title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
    </div>
    <div class="watch-head">
      <div>
        <h1>${esc(v.title)}</h1>
        <p class="muted">${v.story ? esc(v.story) + ' • ' : ''}${v.episode ? esc(v.episode) + ' • ' : ''}${v.category_name ? esc(v.category_name) : ''}</p>
      </div>
      <form method="POST" action="/favorites/toggle">
        <input type="hidden" name="video_id" value="${v.id}">
        <input type="hidden" name="next" value="/watch/${v.id}">
        <button class="btn ${fav ? 'btn-main' : 'btn-ghost'}" type="submit">${fav ? '❤️ Remove from Favorites' : '🤍 Add to Favorites'}</button>
      </form>
    </div>
  </section>
  ${related.length ? `<section class="section"><h2 class="section-title">More from this category</h2>${grid(related, user)}</section>` : ''}`;
  res.send(await layout(req, { title: v.title, body, user }));
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
  const body = `
  <section class="section">
    ${backBar()}
    <h2 class="section-title">❤️ My Favorites</h2>
    ${videos.length ? grid(videos, user) : '<div class="empty">Your favorites list is empty — tap ❤️ while watching a video and it will show up here.</div>'}
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
      <h1>👤 My Profile</h1>
      <div class="avatar-upload">
        <input type="file" id="avatarInput" accept="image/*" hidden>
        <label class="btn btn-ghost" for="avatarInput">📸 Change profile photo</label>
        <button type="button" id="avatarSave" class="btn btn-main" disabled>💾 Save photo</button>
        <p id="avatarMsg" class="avatar-msg" role="status"></p>
      </div>
      <table class="profile-table">
        <tr><th>Name</th><td>${esc(user.name)}</td></tr>
        <tr><th>Email</th><td>${esc(user.email)}</td></tr>
        <tr><th>Joined</th><td>${esc(String(user.created_at).slice(0, 10))}</td></tr>
        <tr><th>Favorite videos</th><td>${favCount}</td></tr>
      </table>
      <a class="btn btn-main btn-big" href="/favorites">❤️ View Favorites</a>
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
    return res.send(await adminLayout({ title: 'প্রথম সেটআপ', body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>🔐 অ্যাডমিন পাসওয়ার্ড তৈরি করুন</h1>
      <p class="muted">এটাই প্রথমবার — নিজের জন্য একটা অ্যাডমিন পাসওয়ার্ড বেছে নিন। এটা দিয়েই পরে অ্যাডমিন প্যানেলে ঢুকবেন।</p>
      <form method="POST" action="/admin/setup" class="form">
        <label>নতুন পাসওয়ার্ড<input type="password" name="password" required minlength="6"></label>
        <label>আবার লিখুন<input type="password" name="confirm" required minlength="6"></label>
        <button class="btn btn-main btn-big" type="submit">পাসওয়ার্ড সেট করুন</button>
      </form>
    </div></section>` }));
  }
  if (!(await isAdmin(req))) {
    const err = req.query.err ? '<div class="alert alert-error">পাসওয়ার্ড ভুল হয়েছে।</div>' : '';
    return res.send(await adminLayout({ title: 'অ্যাডমিন লগইন', body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logo}" alt="">
      <h1>🔐 অ্যাডমিন লগইন</h1>
      ${err}
      <form method="POST" action="/admin/login" class="form">
        <label>অ্যাডমিন পাসওয়ার্ড<input type="password" name="password" required></label>
        <button class="btn btn-main btn-big" type="submit">ঢুকুন</button>
      </form>
    </div></section>` }));
  }
  const userCount = (await queryOne('SELECT COUNT(*) AS c FROM users')).c;
  const videoCount = (await queryOne('SELECT COUNT(*) AS c FROM videos')).c;
  const catCount = (await queryOne('SELECT COUNT(*) AS c FROM categories')).c;
  res.send(await adminLayout({ title: 'ড্যাশবোর্ড', body: `
  <section class="section">
    <h2 class="section-title">📊 ড্যাশবোর্ড</h2>
    <div class="statgrid">
      <div class="stat"><strong>${toBn(userCount)}</strong><span>রেজিস্টার্ড ব্যবহারকারী</span></div>
      <div class="stat"><strong>${toBn(videoCount)}</strong><span>মোট ভিডিও</span></div>
      <div class="stat"><strong>${toBn(catCount)}</strong><span>ক্যাটাগরি</span></div>
    </div>
    <div class="quicklinks">
      <a class="btn btn-main" href="/admin/videos">➕ নতুন ভিডিও যোগ করুন</a>
      <a class="btn btn-ghost" href="/admin/categories">ক্যাটাগরি সাজান</a>
      <a class="btn btn-ghost" href="/admin/settings">সাইটের নাম / লোগো / লিংক বদলান</a>
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
  const cats = await allCategories();
  const videos = await queryAll(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC`);
  const catOptions = (sel) => cats.map((c) => `<option value="${c.id}" ${Number(sel) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  res.send(await adminLayout({ title: 'ভিডিও', body: `
  <section class="section">
    <h2 class="section-title">➕ নতুন ভিডিও যোগ করুন</h2>
    <form method="POST" action="/admin/videos" class="form panel">
      <label>YouTube লিংক<input type="text" name="youtube" required placeholder="https://www.youtube.com/watch?v=..."></label>
      <label>ভিডিওর শিরোনাম<input type="text" name="title" required placeholder="যেমন: কালো নদী"></label>
      <label>গল্প / সিরিজের নাম<input type="text" name="story" placeholder="যেমন: AGNIBRITTA"></label>
      <label>পর্ব (এপিসোড)<input type="text" name="episode" placeholder="যেমন: Season 1 • Chapter 01"></label>
      <label>বিবরণ (ছোট্ট সারসংক্ষেপ)<textarea name="synopsis" rows="3" placeholder="গল্পটা সম্পর্কে দুই-তিন লাইন — ফিচার্ড হলে হোমপেজের হিরোতে দেখাবে"></textarea></label>
      <label>ক্যাটাগরি<select name="category_id">${catOptions('')}</select></label>
      <label class="checklabel"><input type="checkbox" name="featured" value="1"> ⭐ ফিচার্ড — হোমপেজের বড় হিরো ব্যানারে এই ভিডিওটা দেখাবে (একবারে একটাই ফিচার্ড থাকে)</label>
      <label>টপ র‍্যাংক (খালি রাখলে টপ লিস্টে যাবে না)<input type="number" name="rank" min="1" step="1" placeholder="যেমন: 1"><small class="muted">প্রতিটা নম্বর একবারই ব্যবহার করুন — 1 মানে টপ লিস্টের সবার উপরে।</small></label>
      <button class="btn btn-main" type="submit">ভিডিও যোগ করুন</button>
    </form>
    <h2 class="section-title">🎬 সব ভিডিও (${toBn(videos.length)})</h2>
    ${videos.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>থাম্বনেইল</th><th>শিরোনাম</th><th>গল্প / পর্ব</th><th>ক্যাটাগরি</th><th></th></tr>
      ${videos.map((v) => `<tr>
        <td><img class="mini-thumb" src="https://i.ytimg.com/vi/${esc(v.youtube_id)}/default.jpg" alt=""></td>
        <td>${v.featured ? '⭐ ' : ''}${v.rank ? '🏆#' + Number(v.rank) + ' ' : ''}${esc(v.title)}</td>
        <td>${esc(v.story)} ${v.episode ? '• ' + esc(v.episode) : ''}</td>
        <td>${esc(v.category_name || '—')}</td>
        <td class="rowbtns">
          <a class="btn btn-ghost btn-sm" href="/admin/videos/${v.id}/edit">এডিট</a>
          <form method="POST" action="/admin/videos/${v.id}/delete" data-confirm="এই ভিডিও মুছে ফেলবেন?"><button class="btn btn-danger btn-sm" type="submit">মুছুন</button></form>
        </td></tr>`).join('')}
    </table></div>` : '<div class="empty">এখনও কোনো ভিডিও নেই।</div>'}
  </section>` }));
});

app.post('/admin/videos', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const yid = extractYouTubeId(req.body.youtube);
  if (!yid) return res.redirect('/admin/videos');
  const featured = req.body.featured ? 1 : 0;
  if (featured) await run('UPDATE videos SET featured = 0');
  await run('INSERT INTO videos(youtube_id, title, story, episode, synopsis, featured, rank, category_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    [yid, String(req.body.title || '').trim() || 'শিরোনামহীন', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      parseRank(req.body.rank), Number(req.body.category_id) || null]);
  res.redirect('/admin/videos');
});

app.get('/admin/videos/:id/edit', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const v = await videoRow(Number(req.params.id));
  if (!v) return res.redirect('/admin/videos');
  const cats = await allCategories();
  res.send(await adminLayout({ title: 'ভিডিও এডিট', body: `
  <section class="section">
    <h2 class="section-title">✏️ ভিডিও এডিট</h2>
    <form method="POST" action="/admin/videos/${v.id}/edit" class="form panel">
      <label>YouTube লিংক<input type="text" name="youtube" required value="https://www.youtube.com/watch?v=${esc(v.youtube_id)}"></label>
      <label>ভিডিওর শিরোনাম<input type="text" name="title" required value="${esc(v.title)}"></label>
      <label>গল্প / সিরিজের নাম<input type="text" name="story" value="${esc(v.story)}"></label>
      <label>পর্ব (এপিসোড)<input type="text" name="episode" value="${esc(v.episode)}"></label>
      <label>বিবরণ (ছোট্ট সারসংক্ষেপ)<textarea name="synopsis" rows="3" placeholder="গল্পটা সম্পর্কে দুই-তিন লাইন">${esc(v.synopsis || '')}</textarea></label>
      <label>ক্যাটাগরি<select name="category_id">${cats.map((c) => `<option value="${c.id}" ${v.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="checklabel"><input type="checkbox" name="featured" value="1" ${v.featured ? 'checked' : ''}> ⭐ ফিচার্ড — হোমপেজের বড় হিরো ব্যানারে এই ভিডিওটা দেখাবে (একবারে একটাই ফিচার্ড থাকে)</label>
      <label>টপ র‍্যাংক (খালি রাখলে টপ লিস্টে যাবে না)<input type="number" name="rank" min="1" step="1" placeholder="যেমন: 1" value="${v.rank ? Number(v.rank) : ''}"><small class="muted">প্রতিটা নম্বর একবারই ব্যবহার করুন — 1 মানে টপ লিস্টের সবার উপরে।</small></label>
      <button class="btn btn-main" type="submit">সেভ করুন</button>
      <a class="btn btn-ghost" href="/admin/videos">ফিরে যান</a>
    </form>
  </section>` }));
});

app.post('/admin/videos/:id/edit', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const yid = extractYouTubeId(req.body.youtube);
  if (!yid) return res.redirect('/admin/videos');
  const id = Number(req.params.id);
  const featured = req.body.featured ? 1 : 0;
  if (featured) await run('UPDATE videos SET featured = 0 WHERE id != ?', [id]);
  await run('UPDATE videos SET youtube_id = ?, title = ?, story = ?, episode = ?, synopsis = ?, featured = ?, rank = ?, category_id = ? WHERE id = ?',
    [yid, String(req.body.title || '').trim() || 'শিরোনামহীন', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      parseRank(req.body.rank), Number(req.body.category_id) || null, id]);
  res.redirect('/admin/videos');
});

app.post('/admin/videos/:id/delete', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const id = Number(req.params.id);
  await run('DELETE FROM favorites WHERE video_id = ?', [id]);
  await run('DELETE FROM videos WHERE id = ?', [id]);
  res.redirect('/admin/videos');
});

app.get('/admin/categories', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const cats = await allCategories();
  res.send(await adminLayout({ title: 'ক্যাটাগরি', body: `
  <section class="section">
    <h2 class="section-title">➕ নতুন ক্যাটাগরি</h2>
    <form method="POST" action="/admin/categories" class="form panel inline-add">
      <input type="text" name="name" required placeholder="ক্যাটাগরির নাম">
      <button class="btn btn-main" type="submit">যোগ করুন</button>
    </form>
    <h2 class="section-title">📚 সব ক্যাটাগরি (${toBn(cats.length)})</h2>
    <div class="tablewrap"><table class="admintable">
      <tr><th>নাম</th><th>ভিডিও</th><th></th></tr>
      ${cats.map((c) => `<tr>
        <td>
          <form method="POST" action="/admin/categories/${c.id}/rename" class="rename-form">
            <input type="text" name="name" value="${esc(c.name)}" required>
            <button class="btn btn-ghost btn-sm" type="submit">নাম বদলান</button>
          </form>
        </td>
        <td>${toBn(c.video_count)}টি</td>
        <td><form method="POST" action="/admin/categories/${c.id}/delete" data-confirm="এই ক্যাটাগরি মুছবেন? এর ভিডিওগুলো ক্যাটাগরি ছাড়া হয়ে যাবে।"><button class="btn btn-danger btn-sm" type="submit">মুছুন</button></form></td>
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
  res.send(await adminLayout({ title: 'ব্যবহারকারী', body: `
  <section class="section">
    <h2 class="section-title">👥 রেজিস্টার্ড ব্যবহারকারী — মোট ${toBn(users.length)} জন</h2>
    ${users.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>#</th><th>নাম</th><th>ইমেইল</th><th>যোগ দিয়েছেন</th></tr>
      ${users.map((u) => `<tr><td>${toBn(u.id)}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(String(u.created_at).slice(0, 10))}</td></tr>`).join('')}
    </table></div>` : '<div class="empty">এখনও কেউ অ্যাকাউন্ট খোলেনি।</div>'}
  </section>` }));
});

app.get('/admin/settings', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const msg = req.query.ok ? '<div class="alert alert-ok">সেভ হয়েছে ✅</div>' : '';
  const err = req.query.err ? `<div class="alert alert-error">${esc(req.query.err)}</div>` : '';
  const name = await siteName();
  const logo = await logoSrc();
  const youtubeUrl = (await getSetting('youtube_url')) || '';
  const facebookUrl = (await getSetting('facebook_url')) || '';
  res.send(await adminLayout({ title: 'সেটিংস', body: `
  <section class="section">
    <h2 class="section-title">⚙️ সেটিংস</h2>
    ${msg}${err}
    <form method="POST" action="/admin/settings" class="form panel">
      <label>সাইটের নাম<input type="text" name="site_name" value="${esc(name)}" required></label>
      <label>YouTube চ্যানেলের লিংক<input type="text" name="youtube_url" value="${esc(youtubeUrl)}" placeholder="https://www.youtube.com/@YourChannel"></label>
      <label>Facebook পেজের লিংক<input type="text" name="facebook_url" value="${esc(facebookUrl)}" placeholder="https://www.facebook.com/YourPage"></label>
      <button class="btn btn-main" type="submit">সেভ করুন</button>
      <p class="muted">YouTube/Facebook লিংক খালি থাকলে নতুন ব্যবহারকারীর স্বাগত পেজে ওই বাটনটা দেখাবে না।</p>
    </form>
    <h2 class="section-title">🖼️ সাইটের লোগো</h2>
    <div class="panel">
      <p>বর্তমান লোগো:</p>
      <img class="logo-preview" src="${logo}" alt="">
      <form method="POST" action="/admin/logo" enctype="multipart/form-data" class="form">
        <label>নতুন লোগো ছবি (PNG/JPG/WebP, সর্বোচ্চ ৩MB)<input type="file" name="logo" accept="image/*" required></label>
        <button class="btn btn-main" type="submit">লোগো আপলোড করুন</button>
      </form>
      <form method="POST" action="/admin/logo/reset" data-confirm="ডিফল্ট লোগোতে ফিরে যাবেন?">
        <button class="btn btn-ghost" type="submit">ডিফল্ট লোগোতে ফিরুন</button>
      </form>
    </div>
    <h2 class="section-title">🔑 অ্যাডমিন পাসওয়ার্ড বদলান</h2>
    <form method="POST" action="/admin/settings/password" class="form panel">
      <label>বর্তমান পাসওয়ার্ড<input type="password" name="current" required></label>
      <label>নতুন পাসওয়ার্ড<input type="password" name="next" required minlength="6"></label>
      <button class="btn btn-main" type="submit">পাসওয়ার্ড বদলান</button>
    </form>
  </section>` }));
});

app.post('/admin/settings', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  await setSetting('site_name', String(req.body.site_name || '').trim() || 'Stories Come Alive');
  await setSetting('youtube_url', String(req.body.youtube_url || '').trim());
  await setSetting('facebook_url', String(req.body.facebook_url || '').trim());
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/settings/password', async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  const hash = await getSetting('admin_password_hash');
  if (!verifyPassword(String(req.body.current || ''), hash)) {
    return res.redirect('/admin/settings?err=' + encodeURIComponent('বর্তমান পাসওয়ার্ড ভুল।'));
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.redirect('/admin/settings?err=' + encodeURIComponent('নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'));
  await setSetting('admin_password_hash', hashPassword(next));
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/logo', upload.single('logo'), async (req, res) => {
  if (!(await requireAdminPage(req, res))) return;
  if (!req.file) return res.redirect('/admin/settings?err=' + encodeURIComponent('ছবি পাওয়া যায়নি।'));
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
  if (err) return res.redirect('/admin/settings?err=' + encodeURIComponent('আপলোড হয়নি: ' + (err.message || 'ভুল ফাইল')));
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
