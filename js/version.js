/* ── CadastralWorkbench — version manifest ───────────────────────────────── */
window.CW_VERSION = '0.4';
window.CW_BUILD   = '2026-05-19';

window.CW_CHANGELOG = [
  {
    version: '0.4', date: '2026-05-19',
    notes: [
      '版本號點擊開啟開發日誌（此視窗）',
      '地號清單預設改為全不選，新增全選 / 全不選按鈕',
      '公差欄位標示由「限」改為「公差」',
      '新增最大調整幅度滑桿（預設 30 cm，範圍 5–200 cm）',
    ],
  },
  {
    version: '0.3', date: '2026-05-19',
    notes: [
      '加入 Replit 部署支援（main.py + .replit）',
      '集中版本號管理（js/version.js）',
      '修正 drawPolygon [sy,sx] 解構錯誤，拖曳時多邊形與標籤不再分離',
    ],
  },
  {
    version: '0.2', date: '2026-05-18',
    notes: [
      '整合地籍調整模組（Phase 6）',
      '宗地超差標示（紅 / 綠），匯出調整後 COA 及 GeoPackage',
      '「→ 送入調整模組」串接套圖與調整流程',
    ],
  },
  {
    version: '0.1', date: '2026-05-17',
    notes: [
      '初始版本：套圖模組框架',
      'Pyodide Worker 整合（fit_cadastral.py）',
      'Canvas 即時渲染（原始 / 套疊後界址線、殘差可視化）',
    ],
  },
];

document.addEventListener('DOMContentLoaded', function () {
  /* ── Stamp version badge ── */
  var badge = document.getElementById('app-version');
  if (badge) badge.textContent = 'v' + window.CW_VERSION;

  /* ── Populate changelog body ── */
  var body = document.getElementById('changelog-body');
  if (body && window.CW_CHANGELOG) {
    body.innerHTML = window.CW_CHANGELOG.map(function (cl) {
      var lis = cl.notes.map(function (n) { return '<li>' + n + '</li>'; }).join('');
      return (
        '<div class="cl-entry">' +
        '<div class="cl-head">' +
        '<span class="cl-tag">v' + cl.version + '</span>' +
        '<span class="cl-date">' + cl.date + '</span>' +
        '</div>' +
        '<ul class="cl-notes">' + lis + '</ul>' +
        '</div>'
      );
    }).join('');
  }

  /* ── Modal open / close ── */
  var overlay = document.getElementById('changelog-modal');

  function openChangelog() {
    if (overlay) overlay.style.display = 'flex';
  }
  function closeChangelog() {
    if (overlay) overlay.style.display = 'none';
  }

  if (badge) badge.addEventListener('click', openChangelog);

  var closeBtn = document.getElementById('changelog-close');
  if (closeBtn) closeBtn.addEventListener('click', closeChangelog);

  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeChangelog();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeChangelog();
  });
});
