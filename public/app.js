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
      showMsg('এটা ছবি নয় — JPG/PNG ছবি বেছে নিন।', false);
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
      showMsg('ছবি তৈরি — এবার "💾 ছবি সেভ করুন" চাপুন।', true);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showMsg('ছবিটা পড়া যাচ্ছে না — অন্য ছবি চেষ্টা করুন।', false);
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
          showMsg('✅ প্রোফাইল ছবি সেভ হয়েছে!', true);
        } else {
          saveBtn.disabled = false;
          showMsg(data.error || 'সেভ হয়নি — আবার চেষ্টা করুন।', false);
        }
      } catch {
        saveBtn.disabled = false;
        showMsg('সেভ হয়নি — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।', false);
      }
    });
  }
}

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
