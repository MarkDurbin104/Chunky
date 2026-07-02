// Chunky landing page — minimal JS.
// - Reveal sections as they enter the viewport.
// - Explain to the user why download buttons don't work yet.
// - Track no analytics. No third-party requests.

(function () {
  'use strict';

  // ---------- Fade sections in on scroll ----------
  // Only kicks in when IntersectionObserver is available; otherwise the
  // page is already visible with no animation, which is the fallback.
  if ('IntersectionObserver' in window) {
    var reveal = document.querySelectorAll('.section, .hero, .feature, .use-case, .download-card, .mcp-block');
    reveal.forEach(function (el) { el.classList.add('js-fade'); });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('js-fade-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    reveal.forEach(function (el) { io.observe(el); });
  }

  // ---------- Download button messaging ----------
  // aria-disabled="true" on the buttons means the click below is
  // informational, not a link. Once real download URLs exist we swap
  // the anchor `href`s in place and remove the aria-disabled attribute.
  document.querySelectorAll('a[data-download][aria-disabled="true"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      showToast(
        'Downloads become active on first tagged release. Track the '
        + 'GitHub Releases page to be notified when v0.1.0 ships.'
      );
    });
  });

  // ---------- Smooth-scroll anchor links from the nav ----------
  // Native scroll-behavior: smooth handles this; nothing to do here.
  // But we cancel the URL hash update for the "#" home link so the URL
  // stays clean.
  var brand = document.querySelector('.brand[href="#"]');
  if (brand) {
    brand.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ---------- Tiny toast ----------
  var toastEl = null;
  var toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('toast-show');
    }, 4200);
  }
})();
