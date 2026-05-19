/* ── CadastralWorkbench — version manifest ───────────────────────────────── */
window.CW_VERSION = '0.3';
window.CW_BUILD    = '2026-05-19';

/* Stamp the header badge once DOM is ready */
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + window.CW_VERSION;
});
