// Runs before first paint so the saved light/dark choice never flashes.
(function () {
  try {
    var mode = localStorage.getItem('campus-theme');
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  } catch (e) { /* storage unavailable */ }
})();
