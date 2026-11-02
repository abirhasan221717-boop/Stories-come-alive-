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
      showMsg('Photo ready — now tap "💾 Save photo".', true);
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
          showMsg('✅ Profile photo saved!', true);
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
