/* theme-boot.js — runs FIRST, before style.css, to stamp the chosen theme on
 * <html> before the page paints (no light-flash on a dark-theme reload).
 *
 * It must be a separate same-origin file, not an inline <script>: the CSP is
 * `script-src 'self'` with no `unsafe-inline`, so an inline script is blocked.
 *
 * localStorage['vpalTheme'] is a mirror written by settings.js from the
 * per-user `theme` setting. Values: 'light' | 'dark' | 'system' | absent.
 * 'system' / absent => no attribute, and the CSS `@media (prefers-color-scheme)`
 * block does the rest with no JS involved.
 */
(function () {
  try {
    var t = localStorage.getItem('vpalTheme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch {
    /* private mode / storage disabled — fall through to prefers-color-scheme */
  }
})();
