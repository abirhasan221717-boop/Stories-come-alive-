'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, getSetting, setSetting, getAsset, setAsset, deleteAsset } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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
function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.kind = 'user'").get(token);
  return row || null;
}
function isAdmin(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const row = db.prepare("SELECT token FROM sessions WHERE token = ? AND kind = 'admin'").get(token);
  return !!row;
}
function startSession(res, cookieName, userId, kind) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, kind) VALUES(?, ?, ?)').run(token, userId, kind);
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}
function clearSession(req, res, cookieName, kind) {
  const token = parseCookies(req)[cookieName];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ? AND kind = ?').run(token, kind);
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
function siteName() { return getSetting('site_name') || 'Stories Come Alive'; }
function logoSrc() { return '/brand/logo?v=' + (getSetting('logo_version') || '0'); }
function allCategories() {
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
                     FROM categories c ORDER BY c.sort_order, c.id`).all();
}
function videoRow(id) {
  return db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
                     LEFT JOIN categories c ON c.id = v.category_id WHERE v.id = ?`).get(id);
}
function safeNext(next, fallback) {
  const n = String(next || '');
  return n.startsWith('/') && !n.startsWith('//') ? n : fallback;
}

// ---------------- layout ----------------
function layout(req, { title, body, user }) {
  const name = siteName();
  const yt = getSetting('youtube_url');
  const fb = getSetting('facebook_url');
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
    <img class="brand-logo" src="${logoSrc()}" alt="${esc(name)}">
    <span class="brand-name">${esc(name)}</span>
  </a>
  <div class="userbox">
    ${user
      ? `<a class="navlink" href="/favorites">❤️ পছন্দের তালিকা</a>
         <a class="navlink" href="/profile">👤 প্রোফাইল</a>
         <form method="POST" action="/logout" class="inlineform"><button class="btn btn-ghost btn-sm" type="submit">লগআউট</button></form>`
      : `<a class="btn btn-main signin-btn" href="/login">লগইন / Sign In</a>`}
  </div>
</header>
<main>
${body}
</main>
<footer class="footer">
  <div class="footer-brand"><img src="${logoSrc()}" alt=""><span>${esc(name)}</span></div>
  <div class="footer-links">
    ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener">▶️ YouTube-এ Follow করুন</a>` : ''}
    ${fb ? `<a href="${esc(fb)}" target="_blank" rel="noopener">📘 Facebook-এ Follow করুন</a>` : ''}
    <a href="/admin">অ্যাডমিন</a>
  </div>
  <p class="footer-copy">© ${toBn(new Date().getFullYear())} ${esc(name)} — সর্বস্বত্ব সংরক্ষিত।</p>
</footer>
<script src="/app.js"></script>
</body>
</html>`;
}

function adminLayout({ title, body }) {
  const name = siteName();
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
    <img class="brand-logo" src="${logoSrc()}" alt="">
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
      ${v.episode ? `<span class="ep-badge">${esc(v.episode)}</span>` : ''}
      <span class="play-badge">▶</span>
    </div>
    <div class="card-body">
      <h3>${esc(v.title)}</h3>
      ${v.story ? `<p class="card-story">${esc(v.story)}</p>` : ''}
      ${v.category_name ? `<p class="card-cat">${esc(v.category_name)}</p>` : ''}
      ${user ? '' : '<p class="card-lock">🔒 দেখতে লগইন করুন</p>'}
    </div>
  </a>`;
}
function grid(videos, user) {
  if (!videos.length) return '<div class="empty">এখনও কোনো ভিডিও যোগ হয়নি — শীঘ্রই আসছে!</div>';
  return `<div class="grid">${videos.map((v) => videoCard(v, user)).join('')}</div>`;
}

// Horizontally scrollable poster-card row (bhoot-style homepage rows).
function posterRow({ title, videos, user, moreHref }) {
  if (!videos.length) return '';
  return `<section class="section rowsection">
    <div class="rowhead">
      <h2 class="section-title">${title}</h2>
      ${moreHref ? `<a class="rowmore" href="${moreHref}">সবগুলো দেখুন →</a>` : ''}
    </div>
    <div class="rowwrap">
      <div class="rowscroll">${videos.map((v) => videoCard(v, user)).join('')}</div>
      <button class="rowbtn rowbtn-prev" type="button" data-scroll="prev" aria-label="আগের ভিডিওগুলো">‹</button>
      <button class="rowbtn rowbtn-next" type="button" data-scroll="next" aria-label="পরের ভিডিওগুলো">›</button>
    </div>
  </section>`;
}
function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

// ---------------- brand logo ----------------
app.get('/brand/logo', (req, res) => {
  const asset = getAsset('logo');
  if (asset) {
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(asset.data));
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'logo.png'));
});

// ---------------- public pages ----------------
app.get('/', (req, res) => {
  const user = currentUser(req);
  const featured = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.featured = 1 ORDER BY v.id DESC LIMIT 1`).get();
  const latest = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC LIMIT 12`).all();

  let hero;
  if (featured) {
    hero = `
  <section class="fhero">
    <img class="fhero-img" src="https://i.ytimg.com/vi/${esc(featured.youtube_id)}/maxresdefault.jpg"
      onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${esc(featured.youtube_id)}/hqdefault.jpg'" alt="${esc(featured.title)}">
    <div class="fhero-shade"></div>
    <div class="fhero-content">
      ${featured.category_name ? `<span class="fhero-badge">${esc(featured.category_name)}</span>` : ''}
      <h1 class="fhero-title">${esc(featured.title)}</h1>
      ${featured.story ? `<p class="fhero-story">${esc(featured.story)}${featured.episode ? ' • ' + esc(featured.episode) : ''}</p>` : ''}
      ${featured.synopsis ? `<p class="fhero-syn">${esc(truncate(featured.synopsis, 180))}</p>` : ''}
      <a class="btn btn-main fhero-btn" href="/watch/${featured.id}">▶ এখনই দেখুন</a>
      ${user ? '' : '<p class="fhero-note">ভিডিও দেখতে লগইন লাগবে — অ্যাকাউন্ট না থাকলে ফ্রি খুলে নিন।</p>'}
    </div>
  </section>`;
  } else {
    hero = `
  <section class="hero">
    <img class="hero-art" src="/banner.jpg" alt="${esc(siteName())}">
    <div class="hero-overlay">
      <h1 class="sr-only">${esc(siteName())}</h1>
      <p>ক্যাটাগরি অনুযায়ী সাজানো গল্পের ভিডিও লাইব্রেরি — পছন্দের গল্প বেছে দেখুন।</p>
      <form class="searchbar" method="GET" action="/search">
        <input type="text" name="q" placeholder="গল্প বা ভিডিও খুঁজুন…">
        <button class="btn btn-main" type="submit">খুঁজুন</button>
      </form>
      ${user ? '' : '<p class="hero-note">ভিডিও দেখতে <a href="/login">লগইন</a> করুন বা <a href="/register">ফ্রি অ্যাকাউন্ট</a> খুলুন।</p>'}
    </div>
  </section>`;
  }

  let rows = posterRow({ title: '🆕 সর্বশেষ ভিডিও', videos: latest, user });
  for (const c of allCategories()) {
    if (!c.video_count) continue;
    const vids = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC LIMIT 12`).all(c.id);
    rows += posterRow({ title: esc(c.name), videos: vids, user, moreHref: `/category/${c.id}` });
  }
  if (!latest.length) {
    rows = `<section class="section"><div class="empty">এখনও কোনো ভিডিও যোগ হয়নি — শীঘ্রই আসছে!</div></section>`;
  }
  res.send(layout(req, { title: '', body: hero + rows, user }));
});

app.get('/category/:id', (req, res) => {
  const user = currentUser(req);
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!cat) return res.status(404).send(layout(req, { title: 'পাওয়া যায়নি', user, body: '<div class="empty">এই ক্যাটাগরি পাওয়া যায়নি।</div>' }));
  const videos = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.category_id = ? ORDER BY v.id DESC`).all(cat.id);
  const body = `
  <section class="section">
    <h2 class="section-title">${esc(cat.name)}</h2>
    <p class="muted">${toBn(videos.length)}টি ভিডিও</p>
    ${grid(videos, user)}
  </section>`;
  res.send(layout(req, { title: cat.name, body, user }));
});

app.get('/search', (req, res) => {
  const user = currentUser(req);
  const q = String(req.query.q || '').trim();
  const like = '%' + q + '%';
  const videos = q ? db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    WHERE v.title LIKE ? OR v.story LIKE ? ORDER BY v.id DESC`).all(like, like) : [];
  const body = `
  <section class="section">
    <h2 class="section-title">🔎 খোঁজার ফল: ${esc(q)}</h2>
    ${q ? grid(videos, user) : '<div class="empty">কিছু লিখে খুঁজুন।</div>'}
  </section>`;
  res.send(layout(req, { title: 'খুঁজুন', body, user }));
});

// ---------------- auth ----------------
function authPage(req, { mode, error, next }) {
  const isLogin = mode === 'login';
  const body = `
  <section class="auth-wrap">
    <div class="auth-card">
      <img class="auth-logo" src="${logoSrc()}" alt="">
      <h1>${isLogin ? 'লগইন করুন' : 'অ্যাকাউন্ট খুলুন'}</h1>
      <p class="muted">${isLogin ? 'ভিডিও দেখতে লগইন করুন।' : 'ফ্রি অ্যাকাউন্ট খুললেই সব ভিডিও দেখতে পারবেন।'}</p>
      ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
      <form method="POST" action="/${isLogin ? 'login' : 'register'}" class="form">
        <input type="hidden" name="next" value="${esc(next || '')}">
        ${isLogin ? '' : '<label>আপনার নাম<input type="text" name="name" required placeholder="নাম লিখুন"></label>'}
        <label>ইমেইল<input type="email" name="email" required placeholder="email@example.com"></label>
        <label>পাসওয়ার্ড<input type="password" name="password" required minlength="6" placeholder="কমপক্ষে ৬ অক্ষর"></label>
        <button class="btn btn-main btn-big" type="submit">${isLogin ? 'লগইন' : 'অ্যাকাউন্ট খুলুন'}</button>
      </form>
      <p class="auth-alt">${isLogin
        ? 'অ্যাকাউন্ট নেই? <a href="/register">নতুন অ্যাকাউন্ট খুলুন</a>'
        : 'আগেই অ্যাকাউন্ট আছে? <a href="/login">লগইন করুন</a>'}</p>
    </div>
  </section>`;
  return layout(req, { title: isLogin ? 'লগইন' : 'অ্যাকাউন্ট খুলুন', body, user: null });
}

app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  res.send(authPage(req, { mode: 'login', next: req.query.next || '' }));
});
app.get('/register', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  res.send(authPage(req, { mode: 'register', next: req.query.next || '' }));
});

app.post('/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fail = (msg) => res.status(400).send(authPage(req, { mode: 'register', error: msg, next: req.body.next || '' }));
  if (!name) return fail('আপনার নাম লিখুন।');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('সঠিক ইমেইল দিন।');
  if (password.length < 6) return fail('পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return fail('এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট খোলা হয়েছে — লগইন করুন।');
  const info = db.prepare('INSERT INTO users(name, email, password_hash) VALUES(?, ?, ?)')
    .run(name, email, hashPassword(password));
  startSession(res, 'session', Number(info.lastInsertRowid), 'user');
  res.redirect('/welcome');
});

app.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).send(authPage(req, { mode: 'login', error: 'ইমেইল বা পাসওয়ার্ড ভুল হয়েছে।', next: req.body.next || '' }));
  }
  startSession(res, 'session', u.id, 'user');
  res.redirect(safeNext(req.body.next, '/'));
});

app.post('/logout', (req, res) => {
  clearSession(req, res, 'session', 'user');
  res.redirect('/');
});

app.get('/welcome', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const yt = subscribeUrl(getSetting('youtube_url'));
  const fb = String(getSetting('facebook_url') || '').trim();
  const body = `
  <section class="auth-wrap">
    <div class="auth-card welcome-card">
      <img class="auth-logo" src="${logoSrc()}" alt="">
      <h1>স্বাগতম, ${esc(user.name)}! 🎉</h1>
      <p class="muted">আপনার অ্যাকাউন্ট তৈরি হয়ে গেছে। এখন সব ভিডিও দেখতে পারবেন। আমাদের চ্যানেল আর পেজেও যুক্ত হয়ে নিন — নতুন গল্প সবার আগে ওখানেই পাবেন।</p>
      <div class="welcome-btns">
        ${yt ? `<a class="btn btn-youtube btn-big" href="${esc(yt)}" target="_blank" rel="noopener">▶️ YouTube-এ সাবস্ক্রাইব করুন</a>` : ''}
        ${fb ? `<a class="btn btn-facebook btn-big" href="${esc(fb)}" target="_blank" rel="noopener">📘 Facebook পেজে Follow করুন</a>` : ''}
      </div>
      <a class="btn btn-main btn-big" href="/">📚 ভিডিও দেখা শুরু করুন</a>
    </div>
  </section>`;
  res.send(layout(req, { title: 'স্বাগতম', body, user }));
});

// ---------------- watch (login required) ----------------
app.get('/watch/:id', (req, res) => {
  const user = currentUser(req);
  const v = videoRow(Number(req.params.id));
  if (!v) return res.status(404).send(layout(req, { title: 'পাওয়া যায়নি', user, body: '<div class="empty">এই ভিডিও পাওয়া যায়নি।</div>' }));
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/watch/' + v.id));
  const fav = db.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND video_id = ?').get(user.id, v.id);
  const related = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id
    WHERE v.category_id IS ? AND v.id != ? ORDER BY v.id DESC LIMIT 6`).all(v.category_id, v.id);
  const body = `
  <section class="section watch-section">
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
        <button class="btn ${fav ? 'btn-main' : 'btn-ghost'}" type="submit">${fav ? '❤️ পছন্দের তালিকায় আছে' : '🤍 পছন্দের তালিকায় রাখুন'}</button>
      </form>
    </div>
  </section>
  ${related.length ? `<section class="section"><h2 class="section-title">আরও দেখুন</h2>${grid(related, user)}</section>` : ''}`;
  res.send(layout(req, { title: v.title, body, user }));
});

// ---------------- user pages ----------------
app.post('/favorites/toggle', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  const videoId = Number(req.body.video_id);
  if (videoRow(videoId)) {
    const fav = db.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND video_id = ?').get(user.id, videoId);
    if (fav) db.prepare('DELETE FROM favorites WHERE user_id = ? AND video_id = ?').run(user.id, videoId);
    else db.prepare('INSERT INTO favorites(user_id, video_id) VALUES(?, ?)').run(user.id, videoId);
  }
  res.redirect(safeNext(req.body.next, '/favorites'));
});

app.get('/favorites', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/favorites'));
  const videos = db.prepare(`SELECT v.*, c.name AS category_name FROM favorites f
    JOIN videos v ON v.id = f.video_id LEFT JOIN categories c ON c.id = v.category_id
    WHERE f.user_id = ? ORDER BY f.created_at DESC`).all(user.id);
  const body = `
  <section class="section">
    <h2 class="section-title">❤️ আমার পছন্দের তালিকা</h2>
    ${videos.length ? grid(videos, user) : '<div class="empty">পছন্দের তালিকা এখনো খালি — ভিডিও দেখার সময় ❤️ চাপলেই এখানে জমা হবে।</div>'}
  </section>`;
  res.send(layout(req, { title: 'পছন্দের তালিকা', body, user }));
});

app.get('/profile', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login?next=' + encodeURIComponent('/profile'));
  const favCount = db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?').get(user.id).c;
  const body = `
  <section class="auth-wrap">
    <div class="auth-card">
      <img class="auth-logo" src="${logoSrc()}" alt="">
      <h1>👤 আমার প্রোফাইল</h1>
      <table class="profile-table">
        <tr><th>নাম</th><td>${esc(user.name)}</td></tr>
        <tr><th>ইমেইল</th><td>${esc(user.email)}</td></tr>
        <tr><th>যোগ দিয়েছেন</th><td>${esc(String(user.created_at).slice(0, 10))}</td></tr>
        <tr><th>পছন্দের ভিডিও</th><td>${toBn(favCount)}টি</td></tr>
      </table>
      <a class="btn btn-main btn-big" href="/favorites">❤️ পছন্দের তালিকা দেখুন</a>
      <form method="POST" action="/logout" class="form"><button class="btn btn-ghost btn-big" type="submit">লগআউট</button></form>
    </div>
  </section>`;
  res.send(layout(req, { title: 'প্রোফাইল', body, user }));
});

// ---------------- admin ----------------
function requireAdminPage(req, res) {
  if (!getSetting('admin_password_hash')) return false; // handled by setup flow
  if (!isAdmin(req)) { res.redirect('/admin'); return false; }
  return true;
}

app.get('/admin', (req, res) => {
  if (!getSetting('admin_password_hash')) {
    return res.send(adminLayout({ title: 'প্রথম সেটআপ', body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logoSrc()}" alt="">
      <h1>🔐 অ্যাডমিন পাসওয়ার্ড তৈরি করুন</h1>
      <p class="muted">এটাই প্রথমবার — নিজের জন্য একটা অ্যাডমিন পাসওয়ার্ড বেছে নিন। এটা দিয়েই পরে অ্যাডমিন প্যানেলে ঢুকবেন।</p>
      <form method="POST" action="/admin/setup" class="form">
        <label>নতুন পাসওয়ার্ড<input type="password" name="password" required minlength="6"></label>
        <label>আবার লিখুন<input type="password" name="confirm" required minlength="6"></label>
        <button class="btn btn-main btn-big" type="submit">পাসওয়ার্ড সেট করুন</button>
      </form>
    </div></section>` }));
  }
  if (!isAdmin(req)) {
    const err = req.query.err ? '<div class="alert alert-error">পাসওয়ার্ড ভুল হয়েছে।</div>' : '';
    return res.send(adminLayout({ title: 'অ্যাডমিন লগইন', body: `
    <section class="auth-wrap"><div class="auth-card">
      <img class="auth-logo" src="${logoSrc()}" alt="">
      <h1>🔐 অ্যাডমিন লগইন</h1>
      ${err}
      <form method="POST" action="/admin/login" class="form">
        <label>অ্যাডমিন পাসওয়ার্ড<input type="password" name="password" required></label>
        <button class="btn btn-main btn-big" type="submit">ঢুকুন</button>
      </form>
    </div></section>` }));
  }
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const videoCount = db.prepare('SELECT COUNT(*) AS c FROM videos').get().c;
  const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  res.send(adminLayout({ title: 'ড্যাশবোর্ড', body: `
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

app.post('/admin/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.redirect('/admin');
  const pw = String(req.body.password || '');
  if (pw.length < 6 || pw !== String(req.body.confirm || '')) return res.redirect('/admin');
  setSetting('admin_password_hash', hashPassword(pw));
  startSession(res, 'admin_session', null, 'admin');
  res.redirect('/admin');
});

app.post('/admin/login', (req, res) => {
  const hash = getSetting('admin_password_hash');
  if (!hash || !verifyPassword(String(req.body.password || ''), hash)) return res.redirect('/admin?err=1');
  startSession(res, 'admin_session', null, 'admin');
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  clearSession(req, res, 'admin_session', 'admin');
  res.redirect('/admin');
});

app.get('/admin/videos', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const cats = allCategories();
  const videos = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id ORDER BY v.id DESC`).all();
  const catOptions = (sel) => cats.map((c) => `<option value="${c.id}" ${Number(sel) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  res.send(adminLayout({ title: 'ভিডিও', body: `
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
      <button class="btn btn-main" type="submit">ভিডিও যোগ করুন</button>
    </form>
    <h2 class="section-title">🎬 সব ভিডিও (${toBn(videos.length)})</h2>
    ${videos.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>থাম্বনেইল</th><th>শিরোনাম</th><th>গল্প / পর্ব</th><th>ক্যাটাগরি</th><th></th></tr>
      ${videos.map((v) => `<tr>
        <td><img class="mini-thumb" src="https://i.ytimg.com/vi/${esc(v.youtube_id)}/default.jpg" alt=""></td>
        <td>${v.featured ? '⭐ ' : ''}${esc(v.title)}</td>
        <td>${esc(v.story)} ${v.episode ? '• ' + esc(v.episode) : ''}</td>
        <td>${esc(v.category_name || '—')}</td>
        <td class="rowbtns">
          <a class="btn btn-ghost btn-sm" href="/admin/videos/${v.id}/edit">এডিট</a>
          <form method="POST" action="/admin/videos/${v.id}/delete" data-confirm="এই ভিডিও মুছে ফেলবেন?"><button class="btn btn-danger btn-sm" type="submit">মুছুন</button></form>
        </td></tr>`).join('')}
    </table></div>` : '<div class="empty">এখনও কোনো ভিডিও নেই।</div>'}
  </section>` }));
});

app.post('/admin/videos', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const yid = extractYouTubeId(req.body.youtube);
  if (!yid) return res.redirect('/admin/videos');
  const featured = req.body.featured ? 1 : 0;
  if (featured) db.prepare('UPDATE videos SET featured = 0').run();
  db.prepare('INSERT INTO videos(youtube_id, title, story, episode, synopsis, featured, category_id) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(yid, String(req.body.title || '').trim() || 'শিরোনামহীন', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      Number(req.body.category_id) || null);
  res.redirect('/admin/videos');
});

app.get('/admin/videos/:id/edit', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const v = videoRow(Number(req.params.id));
  if (!v) return res.redirect('/admin/videos');
  const cats = allCategories();
  res.send(adminLayout({ title: 'ভিডিও এডিট', body: `
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
      <button class="btn btn-main" type="submit">সেভ করুন</button>
      <a class="btn btn-ghost" href="/admin/videos">ফিরে যান</a>
    </form>
  </section>` }));
});

app.post('/admin/videos/:id/edit', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const yid = extractYouTubeId(req.body.youtube);
  if (!yid) return res.redirect('/admin/videos');
  const id = Number(req.params.id);
  const featured = req.body.featured ? 1 : 0;
  if (featured) db.prepare('UPDATE videos SET featured = 0 WHERE id != ?').run(id);
  db.prepare('UPDATE videos SET youtube_id = ?, title = ?, story = ?, episode = ?, synopsis = ?, featured = ?, category_id = ? WHERE id = ?')
    .run(yid, String(req.body.title || '').trim() || 'শিরোনামহীন', String(req.body.story || '').trim(),
      String(req.body.episode || '').trim(), String(req.body.synopsis || '').trim(), featured,
      Number(req.body.category_id) || null, id);
  res.redirect('/admin/videos');
});

app.post('/admin/videos/:id/delete', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const id = Number(req.params.id);
  db.prepare('DELETE FROM favorites WHERE video_id = ?').run(id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  res.redirect('/admin/videos');
});

app.get('/admin/categories', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const cats = allCategories();
  res.send(adminLayout({ title: 'ক্যাটাগরি', body: `
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

app.post('/admin/categories', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const name = String(req.body.name || '').trim();
  if (name) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories').get().m;
    db.prepare('INSERT INTO categories(name, sort_order) VALUES(?, ?)').run(name, max + 1);
  }
  res.redirect('/admin/categories');
});

app.post('/admin/categories/:id/rename', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  res.redirect('/admin/categories');
});

app.post('/admin/categories/:id/delete', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const id = Number(req.params.id);
  db.prepare('UPDATE videos SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.redirect('/admin/categories');
});

app.get('/admin/users', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const users = db.prepare('SELECT * FROM users ORDER BY id DESC').all();
  res.send(adminLayout({ title: 'ব্যবহারকারী', body: `
  <section class="section">
    <h2 class="section-title">👥 রেজিস্টার্ড ব্যবহারকারী — মোট ${toBn(users.length)} জন</h2>
    ${users.length ? `<div class="tablewrap"><table class="admintable">
      <tr><th>#</th><th>নাম</th><th>ইমেইল</th><th>যোগ দিয়েছেন</th></tr>
      ${users.map((u) => `<tr><td>${toBn(u.id)}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(String(u.created_at).slice(0, 10))}</td></tr>`).join('')}
    </table></div>` : '<div class="empty">এখনও কেউ অ্যাকাউন্ট খোলেনি।</div>'}
  </section>` }));
});

app.get('/admin/settings', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const msg = req.query.ok ? '<div class="alert alert-ok">সেভ হয়েছে ✅</div>' : '';
  const err = req.query.err ? `<div class="alert alert-error">${esc(req.query.err)}</div>` : '';
  res.send(adminLayout({ title: 'সেটিংস', body: `
  <section class="section">
    <h2 class="section-title">⚙️ সেটিংস</h2>
    ${msg}${err}
    <form method="POST" action="/admin/settings" class="form panel">
      <label>সাইটের নাম<input type="text" name="site_name" value="${esc(siteName())}" required></label>
      <label>YouTube চ্যানেলের লিংক<input type="text" name="youtube_url" value="${esc(getSetting('youtube_url') || '')}" placeholder="https://www.youtube.com/@YourChannel"></label>
      <label>Facebook পেজের লিংক<input type="text" name="facebook_url" value="${esc(getSetting('facebook_url') || '')}" placeholder="https://www.facebook.com/YourPage"></label>
      <button class="btn btn-main" type="submit">সেভ করুন</button>
      <p class="muted">YouTube/Facebook লিংক খালি থাকলে নতুন ব্যবহারকারীর স্বাগত পেজে ওই বাটনটা দেখাবে না।</p>
    </form>
    <h2 class="section-title">🖼️ সাইটের লোগো</h2>
    <div class="panel">
      <p>বর্তমান লোগো:</p>
      <img class="logo-preview" src="${logoSrc()}" alt="">
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

app.post('/admin/settings', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  setSetting('site_name', String(req.body.site_name || '').trim() || 'Stories Come Alive');
  setSetting('youtube_url', String(req.body.youtube_url || '').trim());
  setSetting('facebook_url', String(req.body.facebook_url || '').trim());
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/settings/password', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  const hash = getSetting('admin_password_hash');
  if (!verifyPassword(String(req.body.current || ''), hash)) {
    return res.redirect('/admin/settings?err=' + encodeURIComponent('বর্তমান পাসওয়ার্ড ভুল।'));
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.redirect('/admin/settings?err=' + encodeURIComponent('নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'));
  setSetting('admin_password_hash', hashPassword(next));
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/logo', upload.single('logo'), (req, res) => {
  if (!requireAdminPage(req, res)) return;
  if (!req.file) return res.redirect('/admin/settings?err=' + encodeURIComponent('ছবি পাওয়া যায়নি।'));
  setAsset('logo', req.file.mimetype, req.file.buffer);
  setSetting('logo_version', String(Date.now()));
  res.redirect('/admin/settings?ok=1');
});

app.post('/admin/logo/reset', (req, res) => {
  if (!requireAdminPage(req, res)) return;
  deleteAsset('logo');
  setSetting('logo_version', String(Date.now()));
  res.redirect('/admin/settings?ok=1');
});

// upload errors (e.g. wrong file type / too big)
app.use((err, req, res, next) => {
  if (err) return res.redirect('/admin/settings?err=' + encodeURIComponent('আপলোড হয়নি: ' + (err.message || 'ভুল ফাইল')));
  next();
});

app.use((req, res) => {
  const user = currentUser(req);
  res.status(404).send(layout(req, { title: 'পাওয়া যায়নি', user, body: '<div class="empty">দুঃখিত, এই পেজটা নেই। <a href="/">হোমে যান</a></div>' }));
});

app.listen(PORT, () => {
  console.log(`Stories Come Alive — library running on port ${PORT} (db: ${require('./db').DB_PATH})`);
});
