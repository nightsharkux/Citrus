// Runs before first paint so the saved light/dark choice never flashes, and starts fetching the German
// dictionary early for people who use German (everyone else never downloads it).
(function () {
  try {
    var mode = localStorage.getItem('campus-theme');
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  } catch (e) { /* storage unavailable */ }
  try {
    var saved = localStorage.getItem('campus-lang');
    var german = saved ? saved === 'de' : /^de\b/i.test(navigator.language || '');
    if (german) {
      ['i18n-de', 'i18n-de-shell', 'i18n-de-pages', 'i18n-de-staff', 'i18n-de-more', 'i18n-de-learn'].forEach(function (name) {
        var link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = '/js/core/' + name + '.js';
        document.head.appendChild(link);
      });
    }
  } catch (e) { /* storage unavailable */ }
})();
