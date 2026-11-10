// Runs before first paint so the saved light/dark choice never flashes, and starts fetching the German
// dictionary early for people who use German (everyone else never downloads it).
(function () {
  try {
    var mode = localStorage.getItem('campus-theme');
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    // Dark unless someone chose light or "match system": the sign-in page and the app start dark.
    else if (mode !== 'system') {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.themeDefault = '1';
    }
  } catch (e) { /* storage unavailable */ }
  try {
    var saved = localStorage.getItem('campus-lang');
    var german = saved ? saved === 'de' : /^de\b/i.test(navigator.language || '');
    // This script is itself served as theme-boot.js?v=<hash>: use the same version so preloads match the imports.
    var versionSuffix = (/[?&]v=[0-9a-f]+/.exec(document.currentScript && document.currentScript.src) || [''])[0].replace(/^[?&]/, '?');
    if (german) {
      ['i18n-de', 'i18n-de-shell', 'i18n-de-pages', 'i18n-de-staff', 'i18n-de-more', 'i18n-de-learn'].forEach(function (name) {
        var link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = '/js/core/' + name + '.js' + versionSuffix;
        document.head.appendChild(link);
      });
    }
  } catch (e) { /* storage unavailable */ }
})();

// The browser or installed-app bar takes the page's own background colour, light or dark, never the accent.
(function () {
  function sync() {
    var dark = document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    var color = dark ? '#0C0A17' : '#F2F1F7';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) { m.remove(); });
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  }
  window.campusThemeColor = sync;
  sync();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
})();
