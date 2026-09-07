/* ── CadastralWorkbench — version manifest ───────────────────────────────── */
window.CW_VERSION = '0.9.10';
window.CW_BUILD   = '2026-09-07';

window.CW_CHANGELOG = [
  {
    version: '0.9.10', date: '2026-09-07',
    notes: [
      '修正接圖模組匯出 BNP 的「總點數」欄寬：先前版本誤把這個欄位算成 6 碼，實際上是 4 碼，導致後面每個界址點的位置整體多位移了 2 個字元。自己的解析器因為用 int() 轉換會自動忽略多餘空白，沒能抓到這個問題，但地政重測系統 NECEXE 是照精確欄位位置讀取，位移後界址線完全讀不到、只剩點位',
      '同時修正資料行沒有補滿固定行長的問題（界址點不足 11 個時，原本會把行縮短，現在會比照原始格式補空白到滿寬）',
      '用「逐一比對每個數字在原始檔案位元組中的精確位置」重新驗證：單一分幅重新匯出後，界址線資料列與原始 KC0336.BNP 逐字元完全相同',
    ],
  },
  {
    version: '0.9.9', date: '2026-09-07',
    notes: [
      '修正接圖模組匯出 BNP 檔頭（第一行）的欄寬：先前版本在檔名與筆數欄位間多加了一個空白，跟資料列一樣的問題——地政軟體若靠這個檔頭讀出的筆數決定要讀幾行，欄位一位移就會整段界址線被判斷成 0 筆，只剩 COA 的點位看得到',
      '改用檔名(6碼)+筆數(5碼)緊貼、不加分隔的格式，COA/BNP/PAR 三個檔頭一併修正',
    ],
  },
  {
    version: '0.9.8', date: '2026-09-07',
    notes: [
      '修正接圖模組匯出 COA/BNP/PAR 的 BNP 欄寬錯誤：先前版本在段/小段/序號/總點數與各界址點之間多加了空白分隔，跟地政/CAD 軟體用固定欄寬讀取的方式對不起來，開啟後界址線會連成一堆放射狀亂線',
      '改用從實際資料回推驗證出的正確欄寬（段4+小段4+序號3+總點數6，界址點每格固定6碼緊貼），並同步修正解析邏輯',
    ],
  },
  {
    version: '0.9.7', date: '2026-09-07',
    notes: [
      '新增「接圖」模組：拖放包含多個分幅子資料夾的上層資料夾（每個子資料夾各含一組 COA/BNP/PAR），解析並合併成單一連續地籍圖層',
      '合併結果依分幅上色顯示於畫布，並偵測不同分幅間相距 0.5 m 內的界址點，列出可能的共邊座標微差品質報告',
      '可匯出含段/小段/登記面積/圖解面積屬性的 GeoPackage，或 GeoJSON',
      '可匯出合併後的 COA/BNP/PAR（沿用輸入分幅的原始 KC 基底檔名），支援直接選取資料夾寫入；跨分幅（段,小段）撞號時自動錯開編號並列出調整清單',
    ],
  },
  {
    version: '0.9.6', date: '2026-08-13',
    notes: [
      '地號較差資訊文字改為隨畫布縮放比例同步縮放：縮小時字體跟著變小，地籍線成為畫面主體；放大時字體跟著變大',
      '文字放大幅度會依離畫面中心的距離衰減——放大到某地號時（通常會置於畫面中央）該地號文字明顯放大方便閱讀，畫面邊緣的地號文字則不會等比放大到爆版',
      '調整模組正常檢視與手動調整模式的地號標籤／較差文字皆套用此效果',
    ],
  },
  {
    version: '0.9.5', date: '2026-08-13',
    notes: [
      '修正：上一版「進入手動模式自動縮放」在宗地密集區域反而幫倒忙——只勾選 1 筆宗地時，縮放後同畫面可能同時出現上百筆完全不相關、只是剛好在附近的宗地，每筆都畫出完整標籤與較差文字，擠成一團看起來像「其他宗地跑到別的地方去了」',
      '畫布上現在只對「本次自動調整過的宗地」與「拓樸上真正共用界址點的鄰地」顯示完整標籤/較差資訊，其餘宗地僅顯示淡色輪廓；點擊或滑鼠移到任何宗地時仍會即時顯示該筆資訊',
    ],
  },
  {
    version: '0.9.4', date: '2026-08-13',
    notes: [
      '修正：進入手動調整模式時畫面沒有自動縮放，資料筆數多時（上千筆宗地）本次自動調整過的宗地在畫面上只剩幾個像素——標籤/較差資訊擠成一團看不清楚，且點擊判定半徑換算成實際距離會涵蓋到鄰近但不同的宗地，導致誤選、誤動到鄰地界址點、以為調整沒生效',
      '進入手動調整模式時，畫面會自動縮放至本次自動調整過的宗地範圍，資訊清楚可讀、點擊選取更精準',
    ],
  },
  {
    version: '0.9.3', date: '2026-08-13',
    notes: [
      '新增單機執行檔（PyInstaller），免安裝雙擊即用，啟動時自動檢查 GitHub Releases 最新版並自我更新',
      '手動調整模式：畫布上新增橘色虛線顯示「進入手動模式當下的基準位置」，方便對照本次手動調整改了哪裡',
      '手動調整結果現在會正確併入「調整結果」清單並可匯出 DXF/PDF（先前若該宗地未經自動調整，手動調整會在離開模式後遺失）',
      '調整結果清單：手動調整過的宗地新增 ✏️ 標記與額外位移量',
      'PDF 調整報告：曾手動調整的宗地會多畫「自動調整後（手動調整前）」橘色虛線，並將位移箭頭拆成自動／手動兩段顏色',
    ],
  },
  {
    version: '0.9.2', date: '2026-05-21',
    notes: [
      '修正：快捷鈕 🔄/🗺 不再切換畫布模組，效果直接套用於當前模組（套圖/調整皆適用）',
      '修正：調整模組下可一鍵轉 TWD97（宗地座標原位轉換，底圖即時對齊）',
      '重構：showSidePanel() 只換側欄顯示，activeTab 保持不變',
    ],
  },
  {
    version: '0.9.1', date: '2026-05-21',
    notes: [
      'UI 優化：工具列移除 TWD97、底圖分頁標籤及日誌按鈕（減少擁擠）',
      '🔄 轉 TWD97 與 🗺 底圖開關移至畫布右下角縮放按鈕列（載入資料後方可使用）',
      '底圖按鈕啟用後呈綠色高亮顯示；TWD97 轉換後自動停用並標示完成',
    ],
  },
  {
    version: '0.9', date: '2026-05-21',
    notes: [
      'UI 全面重設計：AutoCAD 風格 — 頂部標題列 + 工具列 + 可收合側邊欄 + 狀態列',
      '新增一鍵轉 TWD97（TWD67→TWD97 Helmert 三參數轉換，內政部公告參數）',
      '新增 NLSC 底圖套繪：國土測繪航照圖 / 電子地圖 / OpenStreetMap，可調透明度',
      '版本號點擊開啟開發日誌整合',
    ],
  },
  {
    version: '0.8', date: '2026-05-21',
    notes: [
      '調整模組：登記面積、計算面積、較差、公差標示預設全開',
      '手動調整新增撤銷功能（Ctrl+Z / ⎌ 上一步按鈕，最多 80 步）',
      '手動調整新增「原始狀態」按鈕：回到自動調整前的原始 COA 座標',
    ],
  },
  {
    version: '0.7', date: '2026-05-21',
    notes: [
      '新增手動調整模式：自動調整後可點擊界址點 / 邊線 / 宗地，用方向鍵移動，即時顯示各地號面積差與公差',
      '支援共用界址點同步移動（epsilon 吻合判斷）',
      '套用後自動更新調整結果統計與顏色標示',
      '新增 PDF 調整報告輸出：A4 示意圖含調整前後輪廓、位移向量、最大位移點標示',
    ],
  },
  {
    version: '0.6', date: '2026-05-21',
    notes: [
      '點擊地號清單中的地號標籤，地籍圖即 Zoom In 到該宗地',
      '新增圖層顯示開關：登記面積、計算面積、較差、公差（即時標注於地籍圖）',
    ],
  },
  {
    version: '0.5', date: '2026-05-19',
    notes: [
      '調整結果每筆宗地新增「📐 DXF」下載按鈕（單筆輸出）',
      'DXF 格式：AC1015 (R2000)，含 ADJ_BEFORE（紅）/ ADJ_AFTER（綠）/ LABEL 三個圖層',
      '座標系統：TWD97 (EPSG:3826)，單位公尺',
    ],
  },
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
