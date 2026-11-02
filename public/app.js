// Small progressive enhancements only — the site works fully without JS.
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
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
