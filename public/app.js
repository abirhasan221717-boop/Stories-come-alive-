// Small progressive enhancements only — the site works fully without JS.
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
  });
});

// Back buttons: go back in history, or home when there is nowhere to go back to.
document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  });
});

// Profile picture: downscale the chosen image in the browser (max 256×256 JPEG),
// preview it in the avatar circle, then save the small data URL to the server.
const avatarInput = document.getElementById('avatarInput');
if (avatarInput) {
  const saveBtn = document.getElementById('avatarSave');
  const msg = document.getElementById('avatarMsg');
  const avatarImg = document.getElementById('profileAvatarImg');
  let pendingDataUrl = '';
  const showMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'avatar-msg ' + (ok ? 'ok' : 'err');
  };
  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files && avatarInput.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      showMsg("That's not an image — please choose a JPG/PNG photo.", false);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 256;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      pendingDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (avatarImg) avatarImg.src = pendingDataUrl;
      if (saveBtn) saveBtn.disabled = false;
      showMsg('Photo ready — now tap "Save photo".', true);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showMsg("Couldn't read that photo — please try another one.", false);
    };
    img.src = url;
  });
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!pendingDataUrl) return;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/profile/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: pendingDataUrl }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          pendingDataUrl = '';
          showMsg('Profile photo saved!', true);
        } else {
          saveBtn.disabled = false;
          showMsg(data.error || "Couldn't save — please try again.", false);
        }
      } catch {
        saveBtn.disabled = false;
        showMsg("Couldn't save — check your connection and try again.", false);
      }
    });
  }
}

// Featured hero synopsis: Read More / Read Less expands and collapses in place.
document.querySelectorAll('[data-syn-toggle]').forEach((btn) => {
  const syn = btn.previousElementSibling;
  if (!syn || !syn.hasAttribute('data-syn')) return;
  btn.addEventListener('click', () => {
    const open = syn.classList.toggle('open');
    btn.textContent = open ? 'Read Less' : 'Read More';
  });
});

// Comment replies: a comment's Reply button shows/hides its reply form.
document.querySelectorAll('[data-reply-toggle]').forEach((btn) => {
  const form = document.querySelector('[data-reply-form="' + btn.getAttribute('data-reply-toggle') + '"]');
  if (!form) return;
  btn.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const ta = form.querySelector('textarea');
      if (ta) ta.focus();
    }
  });
});

// Top Picks row: auto-slide one card at a time (Bhoot-style). Pauses while
// the viewer interacts and resumes a few seconds after they stop.
document.querySelectorAll('[data-autoslide]').forEach((scroller) => {
  const cards = scroller.querySelectorAll('.card');
  if (cards.length < 2) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let timer = null;
  let resumeTimer = null;
  const step = () => {
    const gap = parseFloat(getComputedStyle(scroller).gap) || 12;
    const w = cards[0].offsetWidth + gap;
    const max = scroller.scrollWidth - scroller.clientWidth - 8;
    if (scroller.scrollLeft >= max) scroller.scrollTo({ left: 0, behavior: 'smooth' });
    else scroller.scrollBy({ left: w, behavior: 'smooth' });
  };
  const start = () => { if (!timer) timer = setInterval(step, 3000); };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const pause = () => { stop(); if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = setTimeout(start, 5000); };
  const wrap = scroller.closest('.rowwrap') || scroller;
  wrap.addEventListener('pointerdown', pause);
  scroller.addEventListener('wheel', pause, { passive: true });
  scroller.addEventListener('mouseenter', stop);
  scroller.addEventListener('mouseleave', start);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  start();
});

// Homepage poster rows: prev/next scroll buttons (native swipe works on touch devices).
document.querySelectorAll('.rowwrap').forEach((wrap) => {
  const scroller = wrap.querySelector('.rowscroll');
  if (!scroller) return;
  wrap.querySelectorAll('[data-scroll]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-scroll') === 'next' ? 1 : -1;
      scroller.scrollBy({ left: dir * Math.round(scroller.clientWidth * 0.8), behavior: 'smooth' });
    });
  });
});

// Follow / Subscribe panel: opened from the public header button, closed
// with the ✕ button, a backdrop click, or Escape. The panel markup is
// server-rendered and its buttons are plain links, so this stays a pure
// progressive enhancement.
const followPanel = document.querySelector('[data-follow-panel]');
if (followPanel) {
  let followLastFocus = null;
  const openFollowPanel = () => {
    followLastFocus = document.activeElement;
    followPanel.hidden = false;
    document.body.style.overflow = 'hidden';
    const closeBtn = followPanel.querySelector('[data-follow-close]');
    if (closeBtn) closeBtn.focus();
  };
  const closeFollowPanel = () => {
    followPanel.hidden = true;
    document.body.style.overflow = '';
    if (followLastFocus && typeof followLastFocus.focus === 'function') followLastFocus.focus();
  };
  document.querySelectorAll('[data-follow-open]').forEach((btn) => {
    btn.addEventListener('click', openFollowPanel);
  });
  followPanel.addEventListener('click', (e) => {
    if (e.target === followPanel || (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-follow-close]'))) {
      closeFollowPanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !followPanel.hidden) closeFollowPanel();
  });
}

// Admin Settings: social-link list editor — add/remove channel/page rows.
// Pure progressive enhancement: rows are ordinary form fields, so the form
// still submits correctly with JS disabled (existing rows can be edited or
// blanked; only adding brand-new rows needs JS).
document.addEventListener('click', (e) => {
  if (!e.target || typeof e.target.closest !== 'function') return;
  const addBtn = e.target.closest('[data-add-link]');
  if (addBtn) {
    const platform = addBtn.getAttribute('data-add-link');
    const rows = document.querySelector('[data-linkrows="' + platform + '"]');
    const tpl = document.querySelector('template[data-linktemplate="' + platform + '"]');
    if (rows && tpl) {
      rows.appendChild(tpl.content.cloneNode(true));
      const first = rows.lastElementChild ? rows.lastElementChild.querySelector('input') : null;
      if (first) first.focus();
    }
    return;
  }
  const removeBtn = e.target.closest('[data-remove-link]');
  if (removeBtn) {
    const row = removeBtn.closest('[data-linkrow]');
    if (row) row.remove();
  }
});

// Admin header: hamburger menu — the toggle button opens/closes the nav
// dropdown; it also closes on an outside click, on Escape, and once an
// item is chosen. Items are plain links, so navigation works without JS
// (the panel is simply hidden until the button is used).
const adminMenuBtn = document.querySelector('[data-admin-menu-btn]');
const adminMenu = document.querySelector('[data-admin-menu]');
if (adminMenuBtn && adminMenu) {
  const closeAdminMenu = () => {
    adminMenu.hidden = true;
    adminMenuBtn.setAttribute('aria-expanded', 'false');
  };
  adminMenuBtn.addEventListener('click', () => {
    if (adminMenu.hidden) {
      adminMenu.hidden = false;
      adminMenuBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeAdminMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (adminMenu.hidden) return;
    if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.adminmenu-wrap')) {
      closeAdminMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !adminMenu.hidden) {
      closeAdminMenu();
      adminMenuBtn.focus();
    }
  });
  adminMenu.addEventListener('click', (e) => {
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('a')) closeAdminMenu();
  });
}

// Public header: category hamburger menu (mobile stand-in for the sidebar) —
// same interaction pattern as the admin menu above.
const sideMenuBtn = document.querySelector('[data-side-menu-btn]');
const sideMenu = document.querySelector('[data-side-menu]');
if (sideMenuBtn && sideMenu) {
  const closeSideMenu = () => {
    sideMenu.hidden = true;
    sideMenuBtn.setAttribute('aria-expanded', 'false');
  };
  sideMenuBtn.addEventListener('click', () => {
    if (sideMenu.hidden) {
      sideMenu.hidden = false;
      sideMenuBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeSideMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (sideMenu.hidden) return;
    if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.sidemenu-wrap')) {
      closeSideMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sideMenu.hidden) {
      closeSideMenu();
      sideMenuBtn.focus();
    }
  });
  sideMenu.addEventListener('click', (e) => {
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('a')) closeSideMenu();
  });
}

// Highlight the sidebar item for the page being viewed
function markNav() {
  var path = window.location.pathname;
  var hash = window.location.hash;
  var items = Array.prototype.slice.call(document.querySelectorAll('.sidenav-item'));
  if (!items.length) return;
  function byPart(part) {
    return items.filter(function (a) { return (a.getAttribute('href') || '').indexOf(part) > -1; })[0] || null;
  }
  var target = null;
  if (path.indexOf('/category/') === 0) target = byPart('#categories');
  else if (path === '/top-picks') target = byPart('#top-picks');
  else if (path === '/' && hash === '#categories') target = byPart('#categories');
  else if (path === '/' && hash === '#top-picks') target = byPart('#top-picks');
  else if (path === '/') target = items[0];
  else target = items.filter(function (a) { return a.getAttribute('href') === path; })[0] || null;
  if (!target) return;
  items.forEach(function (a) { a.classList.toggle('active', a === target); });
}
markNav();
window.addEventListener('hashchange', markNav);

// Watch page: comments, replies, deletes and star ratings happen in place
// (no page reload), so the video keeps playing.
(function () {
  var commentsSection = document.getElementById('comments');
  var rateForm = document.querySelector('.rate-form');
  if (!commentsSection && !rateForm) return;

  // Reply toggles for comments added after page load (capture phase, so it
  // also serves the buttons rendered by the server without double-toggling).
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-reply-toggle]') : null;
    if (!btn) return;
    e.stopPropagation();
    var form = document.querySelector('[data-reply-form="' + btn.getAttribute('data-reply-toggle') + '"]');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) {
      var ta = form.querySelector('textarea');
      if (ta) ta.focus();
    }
  }, true);

  function setCount(n) {
    if (!commentsSection || typeof n !== 'number') return;
    var title = commentsSection.querySelector('.section-title');
    if (title) title.textContent = 'Comments (' + n + ')';
  }
  function postForm(form) {
    return fetch(form.action, {
      method: 'POST',
      body: new URLSearchParams(new FormData(form)),
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.action) return;
    var isComment = /\/watch\/\d+\/comments$/.test(form.action);
    var isDelete = /\/comments\/\d+\/delete$/.test(form.action);
    if (!isComment && !isDelete) return;
    e.preventDefault();
    if (isDelete) {
      var node = form.closest('.comment');
      postForm(form).then(function (data) {
        if (data.ok) {
          if (node) node.remove();
          setCount(data.count);
        }
      });
      return;
    }
    var ta = form.querySelector('textarea');
    postForm(form).then(function (data) {
      if (!data.ok) {
        if (data.error) alert(data.error);
        return;
      }
      var wrap = document.createElement('div');
      wrap.innerHTML = data.html;
      var newNode = wrap.firstElementChild;
      if (data.parentId) {
        var parent = form.closest('.comment');
        if (parent) {
          var replies = parent.querySelector('.replies');
          if (!replies) {
            replies = document.createElement('div');
            replies.className = 'replies';
            parent.querySelector('.comment-main').appendChild(replies);
          }
          replies.appendChild(newNode);
        }
        form.hidden = true;
      } else if (commentsSection) {
        var list = commentsSection.querySelector('.comments-list');
        if (!list) {
          list = document.createElement('div');
          list.className = 'comments-list';
          var muted = commentsSection.querySelector('.muted');
          if (muted) muted.remove();
          commentsSection.appendChild(list);
        }
        list.insertBefore(newNode, list.firstChild);
      }
      if (ta) ta.value = '';
      setCount(data.count);
    });
  });

  if (rateForm) {
    var clicked = null;
    rateForm.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.star-btn') : null;
      if (btn) clicked = btn.value;
    });
    rateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var stars = clicked;
      if (!stars) return;
      fetch(rateForm.action, {
        method: 'POST',
        body: new URLSearchParams({ stars: stars }),
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data.ok) return;
        var summary = document.querySelector('.rate-summary span');
        if (summary) {
          summary.textContent = data.count
            ? data.avg.toFixed(1) + ' (' + data.count + ' rating' + (data.count === 1 ? '' : 's') + ')'
            : 'No ratings yet';
        }
        rateForm.querySelectorAll('.star-btn').forEach(function (btn, i) {
          var on = (i + 1) <= data.mine;
          btn.classList.toggle('star-on', on);
          var svg = btn.querySelector('svg');
          if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
        });
        var hint = rateForm.querySelector('.rate-hint');
        if (hint) hint.textContent = 'Your rating: ' + data.mine + '/5 — tap a star to change it';
      });
    });
  }
})();

// Favorites button: toggles in place, no page reload.
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form || !form.action || !/\/favorites\/toggle$/.test(form.action)) return;
  e.preventDefault();
  fetch(form.action, {
    method: 'POST',
    body: new URLSearchParams(new FormData(form)),
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin'
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (!data.ok) return;
    var btn = form.querySelector('button');
    if (!btn) return;
    btn.classList.toggle('btn-main', data.fav);
    btn.classList.toggle('btn-ghost', !data.fav);
    var svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', data.fav ? 'currentColor' : 'none');
    for (var i = 0; i < btn.childNodes.length; i++) {
      if (btn.childNodes[i].nodeType === 3 && btn.childNodes[i].textContent.trim()) {
        btn.childNodes[i].textContent = data.fav ? 'Remove from Favorites' : 'Add to Favorites';
      }
    }
  });
});
