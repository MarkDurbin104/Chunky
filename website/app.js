// Chunky landing page — minimal JS.
// - Reveal sections as they enter the viewport.
// - Smooth-scroll the brand click without leaving a "#" in the URL.
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

  // ---------- Smooth-scroll for the brand click ----------
  // Native scroll-behavior: smooth handles the anchor links from the
  // nav; the brand's href="#" would leave a stray hash in the URL,
  // so intercept and scroll-to-top manually.
  var brand = document.querySelector('.brand[href="#"]');
  if (brand) {
    brand.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
})();
