/* ══════════════════════════════════════════════════════════════════════════
   CadastralWorkbench  app.js  v0.2
   純前端：Pyodide Worker + Canvas 渲染（移植自 fit-cadastral webapp）
   ══════════════════════════════════════════════════════════════════════════ */

// ── 全域狀態 ─────────────────────────────────────────────────────────────────
const FIT = {
  data:       null,   // parse 結果（segments / ref_pts / boundary_pts / cy / cx）
  result:     null,   // fit 結果（fitted_segments / details / stats / …）
  weights:    {},     // {idx: weight}
  selectedPt: null,
  layers: { original: true, fitted: true, residuals: true, labels: true, boundary: true },
  fileMap:    {},     // {D14: File, D2C: File, D2D: File, D2B: File}
};

const ADJ = {
  data:    null,   // parse 結果（parcels）
  result:  null,   // adjust 結果
  layers:  { before: true, after: true, labels: true },
  fileMap: {},     // {COA: File, BNP: File, PAR: File}
  coaText: null,   // 調整後 COA 文字（下載用）
};

let activeTab  = 'fit';
let pyodideReady = false;

// ── Canvas / View ─────────────────────────────────────────────────────────────
const canvas  = document.getElementById('map-canvas');
const ctx     = canvas.getContext('2d');
let view     = { scale: 1, tx: 0, ty: 0 };
let drag     = null;
let extents  = null;

function worldToScreen(wy, wx) {
  if (!extents) return [0, 0];
  return [
    (wx - extents.minX) * view.scale + view.tx,
    (extents.maxY - wy) * view.scale + view.ty,
  ];
}
function initView() {
  if (!extents) return;
  const pad = 40;
  const W = canvas.width  - pad * 2;
  const H = canvas.height - pad * 2;
  const rX = extents.maxX - extents.minX || 1;
  const rY = extents.maxY - extents.minY || 1;
  view.scale = Math.min(W / rX, H / rY);
  view.tx = pad + (W - rX * view.scale) / 2;
  view.ty = pad + (H - rY * view.scale) / 2;
}
function resizeCanvas() {
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  if (extents) { initView(); render(); }
}
window.addEventListener('resize', resizeCanvas);

// ── 色彩輔助 ─────────────────────────────────────────────────────────────────
function residualColor(d) {
  if (d < 0.1) return '#3ecf6e';
  if (d < 0.5) return '#f5c542';
  return '#f05252';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════════════════════════
function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // 背景
  ctx.fillStyle = '#0c0e16';
  ctx.fillRect(0, 0, W, H);

  if (activeTab === 'fit') renderFit(W, H);
  else                     renderAdj(W, H);
}

// ── 套圖渲染 ─────────────────────────────────────────────────────────────────
function renderFit(W, H) {
  if (!FIT.data) {
    drawPlaceholder(W, H, '請上傳地籍圖 DBF 檔案', 'D14 · D2C · D2D · D2B');
    return;
  }
  const { segments, ref_pts, boundary_pts } = FIT.data;
  const result = FIT.result;

  // 原始界址線
  if (FIT.layers.original) {
    ctx.strokeStyle = result ? 'rgba(70,120,200,.3)' : 'rgba(70,120,200,.85)';
    ctx.lineWidth   = result ? 0.8 : 1.2;
    ctx.beginPath();
    for (const [y1, x1, y2, x2] of segments) {
      const [sx1, sy1] = worldToScreen(y1, x1);
      const [sx2, sy2] = worldToScreen(y2, x2);
      ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2);
    }
    ctx.stroke();
  }

  // 套疊後界址線
  if (result && FIT.layers.fitted) {
    ctx.strokeStyle = 'rgba(62,207,110,.9)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (const [y1, x1, y2, x2] of result.fitted_segments) {
      const [sx1, sy1] = worldToScreen(y1, x1);
      const [sx2, sy2] = worldToScreen(y2, x2);
      ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2);
    }
    ctx.stroke();
  }

  // 垂距殘差線
  if (result && FIT.layers.residuals) {
    ctx.setLineDash([4, 3]);
    for (const d of result.details) {
      if (d.weight <= 0) continue;
      const col = residualColor(d.d_after);
      const [sx, sy] = worldToScreen(d.y, d.x);
      const [fx, fy] = worldToScreen(d.foot_y, d.foot_x);
      ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(fx, fy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(fx - 4, fy - 4); ctx.lineTo(fx + 4, fy + 4);
      ctx.moveTo(fx + 4, fy - 4); ctx.lineTo(fx - 4, fy + 4);
      ctx.stroke();
      ctx.setLineDash([4, 3]);
    }
    ctx.setLineDash([]);
  }

  // 界址點
  if (FIT.layers.boundary) {
    ctx.fillStyle = 'rgba(200,200,255,.5)';
    for (const { y, x } of boundary_pts) {
      const [sx, sy] = worldToScreen(y, x);
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 參考點
  for (let i = 0; i < ref_pts.length; i++) {
    const { num, y, x } = ref_pts[i];
    const [sx, sy] = worldToScreen(y, x);
    const w = FIT.weights[i] ?? 1.0;
    const detail = result?.details?.[i];
    const col = detail ? residualColor(detail.d_after) : '#4f8ef7';
    const r   = w <= 0 ? 4 : (w < 0.5 ? 5 : w > 1.5 ? 9 : 7);

    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = w <= 0 ? 'rgba(107,114,128,.4)' : col;
    ctx.fill();

    if (FIT.selectedPt === i) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2); ctx.stroke();
    }
    if (w <= 0) {
      ctx.strokeStyle = 'rgba(240,82,82,.8)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5);
      ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5);
      ctx.stroke();
    }
  }

  // 標籤
  if (result && FIT.layers.labels) {
    ctx.font = `${Math.max(9, Math.min(13, view.scale * 2))}px Consolas`;
    ctx.textAlign = 'left';
    for (const d of result.details) {
      if (d.weight <= 0) continue;
      const [sx, sy] = worldToScreen(d.y, d.x);
      const col = residualColor(d.d_after);
      const txt = `${d.num}  ${d.d_after.toFixed(3)}m`;
      ctx.fillStyle = 'rgba(10,12,18,.8)';
      const tw = ctx.measureText(txt).width;
      ctx.fillRect(sx + 8, sy - 11, tw + 6, 15);
      ctx.fillStyle = col;
      ctx.fillText(txt, sx + 11, sy);
    }
  }

  // 旋轉中心
  if (result) {
    const [cx2, cy2] = worldToScreen(result.cy, result.cx);
    ctx.strokeStyle = 'rgba(245,197,66,.6)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx2 - 12, cy2); ctx.lineTo(cx2 + 12, cy2);
    ctx.moveTo(cx2, cy2 - 12); ctx.lineTo(cx2, cy2 + 12);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cx2, cy2, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(245,197,66,.8)'; ctx.fill();
  }
}

// ── 調整渲染 ─────────────────────────────────────────────────────────────────
function renderAdj(W, H) {
  if (!ADJ.data) {
    drawPlaceholder(W, H, '請上傳地籍調整資料', 'COA · BNP · PAR');
    return;
  }

  const result  = ADJ.result;
  const parcels = ADJ.data.parcels;

  // 未調整：依公差狀態上色
  if (!result) {
    for (const p of parcels) {
      if (!p.coords || p.coords.length < 2) continue;
      const col = p.exceeds ? 'rgba(240,82,82,.7)' : 'rgba(62,207,110,.5)';
      drawPolygon(p.coords, col, 1.5);
    }
  } else {
    // 調整前後對比
    const adjKeys = new Set(result.adjusted_parcels.map(p => `${p.main}-${p.sub}`));

    for (const p of parcels) {
      if (adjKeys.has(`${p.main}-${p.sub}`)) continue;
      const col = p.exceeds ? 'rgba(240,82,82,.4)' : 'rgba(62,207,110,.4)';
      drawPolygon(p.coords, col, 1);
    }

    for (const ap of result.adjusted_parcels) {
      if (ADJ.layers.before) {
        ctx.setLineDash([5, 4]);
        drawPolygon(ap.coords_before, 'rgba(240,82,82,.8)', 1.5, false);
        ctx.setLineDash([]);
      }
      if (ADJ.layers.after) {
        drawPolygon(ap.coords_after, '#3ecf6e', 2, false);
      }
    }
  }

  // 宗地標籤
  if (ADJ.layers.labels) {
    ctx.font = `${Math.max(9, Math.min(11, view.scale * 0.8))}px Consolas`;
    ctx.textAlign = 'center';
    for (const p of parcels) {
      if (!p.coords || p.coords.length < 2) continue;
      const cy_ = p.coords.reduce((s, c) => s + c[0], 0) / p.coords.length;
      const cx_ = p.coords.reduce((s, c) => s + c[1], 0) / p.coords.length;
      const [sx, sy] = worldToScreen(cy_, cx_);
      const col = p.exceeds ? '#f05252' : '#3ecf6e';
      ctx.fillStyle = 'rgba(10,12,18,.7)';
      const tw = ctx.measureText(p.label).width;
      ctx.fillRect(sx - tw / 2 - 3, sy - 10, tw + 6, 14);
      ctx.fillStyle = col;
      ctx.fillText(p.label, sx, sy);
    }
  }
}

function drawPolygon(coords, strokeColor, lineWidth, fill = true) {
  if (!coords || coords.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < coords.length; i++) {
    const [sy, sx] = worldToScreen(coords[i][0], coords[i][1]);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = strokeColor.replace(/[\d.]+\)$/, '0.08)');
    ctx.fill();
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = lineWidth;
  ctx.stroke();
}

function drawPlaceholder(W, H, line1, line2) {
  ctx.fillStyle = '#6b7280'; ctx.font = '15px Segoe UI'; ctx.textAlign = 'center';
  ctx.fillText(line1, W / 2, H / 2 - 10);
  ctx.font = '12px Segoe UI'; ctx.fillStyle = '#4b5563';
  ctx.fillText(line2, W / 2, H / 2 + 14);
}

// ── Pan / Zoom ────────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  drag = { sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty };
  canvas.classList.add('panning');
});
window.addEventListener('mousemove', e => {
  if (drag) {
    view.tx = drag.tx0 + (e.clientX - drag.sx);
    view.ty = drag.ty0 + (e.clientY - drag.sy);
    render();
  } else if (activeTab === 'fit' && FIT.data) {
    handleFitHover(e);
  }
});
window.addEventListener('mouseup', e => {
  if (drag) {
    const moved = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy);
    drag = null;
    canvas.classList.remove('panning');
    if (moved < 4 && activeTab === 'fit') handleFitClick(e);
  }
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.15 : 0.87;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  view.tx = mx + (view.tx - mx) * f;
  view.ty = my + (view.ty - my) * f;
  view.scale *= f;
  render();
}, { passive: false });

document.getElementById('btn-zoom-in').onclick  = () => zoom(1.25);
document.getElementById('btn-zoom-out').onclick = () => zoom(0.8);
document.getElementById('btn-zoom-fit').onclick = () => { initView(); render(); };
function zoom(f) {
  const cx_ = canvas.width / 2, cy_ = canvas.height / 2;
  view.tx = cx_ + (view.tx - cx_) * f;
  view.ty = cy_ + (view.ty - cy_) * f;
  view.scale *= f;
  render();
}

// ── 套圖：點擊與 hover ────────────────────────────────────────────────────────
function handleFitClick(e) {
  if (!FIT.data) return;
  const rect = canvas.getBoundingClientRect();
  const hit  = nearestRefPt(e.clientX - rect.left, e.clientY - rect.top, 12);
  if (hit !== null) { FIT.selectedPt = hit; showPointPanel(hit); }
  else              { FIT.selectedPt = null; hidePointPanel(); }
  render();
}

const tooltip = document.getElementById('tooltip');
function handleFitHover(e) {
  if (!FIT.data) return;
  const rect = canvas.getBoundingClientRect();
  const hit  = nearestRefPt(e.clientX - rect.left, e.clientY - rect.top, 14);
  if (hit !== null) {
    const pt  = FIT.data.ref_pts[hit];
    const d   = FIT.result?.details?.[hit];
    const w   = FIT.weights[hit] ?? 1.0;
    let html  = `<div class="tt-num">點號 ${pt.num}</div>`;
    html += `<div>N: ${pt.y.toFixed(3)}</div><div>E: ${pt.x.toFixed(3)}</div>`;
    html += `<div>權重: <b>${w.toFixed(2)}</b></div>`;
    if (d) {
      const cls = d.d_after < 0.1 ? 'tt-good' : d.d_after < 0.5 ? 'tt-warn' : 'tt-bad';
      html += `<div>套疊前: ${d.d_before.toFixed(4)} m</div>`;
      html += `<div class="${cls}">套疊後: ${d.d_after.toFixed(4)} m</div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.left = (e.clientX - canvas.getBoundingClientRect().left + 16) + 'px';
    tooltip.style.top  = (e.clientY - canvas.getBoundingClientRect().top  - 10) + 'px';
    tooltip.classList.add('visible');
  } else {
    tooltip.classList.remove('visible');
  }
}

function nearestRefPt(mx, my, threshold) {
  if (!FIT.data) return null;
  let best = null, bestD = threshold * threshold;
  for (let i = 0; i < FIT.data.ref_pts.length; i++) {
    const { y, x } = FIT.data.ref_pts[i];
    const [sx, sy] = worldToScreen(y, x);
    const d = (sx - mx) ** 2 + (sy - my) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── 選中點面板 ───────────────────────────────────────────────────────────────
const WEIGHTS      = [0, 0.25, 0.5, 1.0, 2.0, 4.0];
const WEIGHT_LABELS = ['排除', '×0.25', '×0.5', '×1', '×2', '×4'];

function showPointPanel(idx) {
  const panel = document.getElementById('point-panel');
  const pt    = FIT.data.ref_pts[idx];
  const d     = FIT.result?.details?.[idx];
  const w     = FIT.weights[idx] ?? 1.0;
  let info    = `<b>點號 ${pt.num}</b><br>N: ${pt.y.toFixed(4)}<br>E: ${pt.x.toFixed(4)}`;
  if (d) {
    const col = d.d_after < 0.1 ? 'var(--green)' : d.d_after < 0.5 ? 'var(--yellow)' : 'var(--red)';
    info += `<br>套疊前: ${d.d_before.toFixed(4)} m<br><span style="color:${col}">套疊後: ${d.d_after.toFixed(4)} m</span>`;
  }
  panel.querySelector('.point-info').innerHTML = info;
  const btns = panel.querySelectorAll('.weight-btn');
  btns.forEach((btn, i) => {
    btn.classList.toggle('active', WEIGHTS[i] === w);
    btn.onclick = () => {
      FIT.weights[idx] = WEIGHTS[i];
      btns.forEach((b, j) => b.classList.toggle('active', j === i));
      render();
      if (FIT.data) triggerFit();
    };
  });
  panel.classList.add('visible');
}
function hidePointPanel() { document.getElementById('point-panel').classList.remove('visible'); }

// ── 圖層開關 ─────────────────────────────────────────────────────────────────
for (const key of Object.keys(FIT.layers)) {
  const el = document.getElementById(`layer-${key}`);
  if (el) el.onchange = () => { FIT.layers[key] = el.checked; render(); };
}
for (const key of ['before', 'after', 'labels']) {
  const el = document.getElementById(`adj-layer-${key}`);
  if (el) el.onchange = () => { ADJ.layers[key] = el.checked; render(); };
}

// ── 分頁切換 ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${activeTab}`).classList.add('active');
    if (extents) { initView(); render(); } else render();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PYODIDE WORKER
// ═══════════════════════════════════════════════════════════════════════════════
const worker = new Worker('./workers/pyodide_worker.js');

worker.onmessage = (e) => {
  const { type, payload } = e.data;
  switch (type) {
    case 'ready':
      setPyodideStatus('ready', 'Pyodide 就緒');
      showToast('Pyodide + scipy 載入完成，可開始上傳檔案');
      pyodideReady = true;
      document.getElementById('btn-upload').disabled    = !canUploadFit();
      document.getElementById('btn-adj-upload').disabled = !canUploadAdj();
      break;
    case 'fit_parse_result':
      onFitParsed(payload);
      break;
    case 'fit_run_result':
      onFitResult(payload);
      break;
    case 'adj_parse_result':
      onAdjParsed(payload);
      break;
    case 'adj_run_result':
      onAdjResult(payload);
      break;
    case 'error':
      showToast('錯誤：' + payload, true);
      progressHide('fit-progress');
      progressHide('adj-progress');
      setBtn('btn-fit',        false, '▶ 執行套疊');
      setBtn('btn-adj-run',    false, '▶ 執行調整');
      break;
  }
};
worker.onerror = (e) => {
  setPyodideStatus('error', 'Worker 錯誤');
  showToast('Worker 錯誤：' + e.message, true);
};

worker.postMessage({ type: 'init' });

// ═══════════════════════════════════════════════════════════════════════════════
//  資料夾遞迴讀取（FileSystemEntry API）
// ═══════════════════════════════════════════════════════════════════════════════
// entries 必須在 drop 事件同步階段就先擷取，await 之後 dataTransfer 就失效
async function processEntries(entries, extensions) {
  const extSet  = new Set(extensions.map(e => e.toUpperCase()));
  const results = [];

  async function walk(entry) {
    if (entry.isFile) {
      const ext = entry.name.split('.').pop().toUpperCase();
      if (extSet.has(ext)) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        results.push(file);
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }
  }

  for (const entry of entries) await walk(entry);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FIT MODULE
// ═══════════════════════════════════════════════════════════════════════════════
const FIT_EXTS = ['D14', 'D2C', 'D2D', 'D2B'];
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

fileInput.onchange = e => handleFitFiles([...e.target.files]);

let _fitDragDepth = 0;
dropZone.addEventListener('dragenter', e => { e.preventDefault(); _fitDragDepth++; dropZone.classList.add('over'); });
dropZone.addEventListener('dragover',  e => { e.preventDefault(); });
dropZone.addEventListener('dragleave', () => { if (--_fitDragDepth <= 0) { _fitDragDepth = 0; dropZone.classList.remove('over'); } });
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  _fitDragDepth = 0;
  dropZone.classList.remove('over');
  // 同步取出 entries 和 fallback files（await 後 dataTransfer 失效）
  const entries      = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const fallback     = [...e.dataTransfer.files];
  const files = entries.length ? await processEntries(entries, FIT_EXTS) : fallback;
  handleFitFiles(files.length ? files : fallback);
});

function handleFitFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toUpperCase();
    if (FIT_EXTS.includes(ext)) FIT.fileMap[ext] = f;
  }
  updateFitFileBadges();
  document.getElementById('btn-upload').disabled = !canUploadFit();
}
function canUploadFit() { return pyodideReady && FIT_EXTS.every(e => FIT.fileMap[e]); }

function updateFitFileBadges() {
  const list = document.getElementById('file-list');
  list.innerHTML = FIT_EXTS.map(ext => {
    const ok = !!FIT.fileMap[ext];
    return `<div class="file-badge"><div class="dot ${ok ? 'ok' : ''}"></div><span>${ext}</span><span style="color:var(--muted);margin-left:auto;font-size:.72rem">${ok ? FIT.fileMap[ext].name : '未選取'}</span></div>`;
  }).join('');
}

document.getElementById('btn-upload').onclick = async () => {
  if (!canUploadFit()) return;
  setBtn('btn-upload', true, '解析中…');
  progressShow('fit-progress');
  try {
    const bufs = {};
    for (const ext of FIT_EXTS) bufs[ext] = await FIT.fileMap[ext].arrayBuffer();
    worker.postMessage({
      type: 'fit_parse',
      payload: { d14: bufs['D14'], d2c: bufs['D2C'], d2d: bufs['D2D'], d2b: bufs['D2B'] },
    }, [bufs['D14'], bufs['D2C'], bufs['D2D'], bufs['D2B']]);
  } catch (err) {
    showToast('讀取失敗：' + err.message, true);
    setBtn('btn-upload', false, '解析並顯示');
    progressHide('fit-progress');
  }
};

function onFitParsed(data) {
  progressHide('fit-progress');
  setBtn('btn-upload', false, '解析並顯示');

  FIT.data    = data;
  FIT.result  = null;
  FIT.weights = {};

  const allY = [], allX = [];
  for (const [y1, x1, y2, x2] of data.segments) { allY.push(y1, y2); allX.push(x1, x2); }
  for (const p of data.ref_pts)      { allY.push(p.y); allX.push(p.x); }
  for (const p of data.boundary_pts) { allY.push(p.y); allX.push(p.x); }
  const pad = (Math.max(...allY) - Math.min(...allY)) * 0.05;
  extents = {
    minY: Math.min(...allY) - pad, maxY: Math.max(...allY) + pad,
    minX: Math.min(...allX) - pad, maxX: Math.max(...allX) + pad,
  };

  resizeCanvas(); initView();
  updateFitStats(data.stats, null);
  document.getElementById('fit-section').style.display = '';
  setBtn('btn-fit', false, '▶ 執行套疊');
  showToast(`解析完成：${data.stats.n_segs} 條線段、${data.stats.n_ref} 個參考點`);
  render();
}

document.getElementById('btn-fit').onclick = triggerFit;
function triggerFit() {
  if (!FIT.data) return;
  setBtn('btn-fit', true, '計算中…');
  progressShow('fit-progress');
  worker.postMessage({ type: 'fit_run', payload: { weights: FIT.weights } });
}

function onFitResult(result) {
  progressHide('fit-progress');
  setBtn('btn-fit', false, '▶ 執行套疊');
  FIT.result = result;
  updateFitStats(FIT.data.stats, result);
  updateFitParams(result);
  document.getElementById('btn-fit-gpkg').style.display     = '';
  document.getElementById('btn-fit-send-adj').style.display = '';
  document.getElementById('btn-download').style.display     = '';
  showToast(`套疊完成  RMSE: ${result.stats.rmse_after.toFixed(4)} m`);
  render();
}

function updateFitStats(dataStats, fitResult) {
  el('stat-segs').textContent = dataStats.n_segs;
  el('stat-ref').textContent  = dataStats.n_ref;
  if (!fitResult) return;
  const { stats } = fitResult;
  const rmseEl = el('stat-rmse');
  rmseEl.textContent = stats.rmse_after.toFixed(4) + ' m';
  rmseEl.className = 'value ' + (stats.rmse_after < 0.1 ? 'green' : stats.rmse_after < 0.5 ? 'yellow' : 'red');
  const maxEl = el('stat-max');
  maxEl.textContent = stats.max_after.toFixed(4) + ' m';
  maxEl.className = 'value ' + (stats.max_after < 0.3 ? 'green' : stats.max_after < 1.0 ? 'yellow' : 'red');
  el('stat-used').textContent = `${stats.n_used} / ${stats.n_ref}`;
}

function updateFitParams(result) {
  el('param-theta').textContent = (result.theta_deg >= 0 ? '+' : '') + result.theta_deg.toFixed(6) + ' °';
  el('param-ty').textContent    = (result.ty >= 0 ? '+' : '') + result.ty.toFixed(4) + ' m';
  el('param-tx').textContent    = (result.tx >= 0 ? '+' : '') + result.tx.toFixed(4) + ' m';
  document.getElementById('params-section').style.display = '';
}

// 匯出 GeoPackage（套圖）
document.getElementById('btn-fit-gpkg').onclick = async () => {
  if (!FIT.result) return;
  showToast('產生 GeoPackage…');
  await writeFitGPKG(FIT.result, FIT.data, FIT.fileMap['D14']?.name?.replace(/\.[^.]+$/, '') || 'fit');
  showToast('GeoPackage 已下載');
};

// 送入調整模組
document.getElementById('btn-fit-send-adj').onclick = () => {
  if (!FIT.result) return;
  showToast('已切換至調整模組（尚需上傳 COA/BNP/PAR）');
  document.getElementById('adj-from-fit').style.display = '';
  document.querySelector('[data-tab="adj"]').click();
};

// 下載結果（TXT 座標）
document.getElementById('btn-download').onclick = () => {
  if (!FIT.result) return;
  exportCoordTXT(FIT.result.fitted_boundary, FIT.fileMap['D14']?.name?.replace(/\.[^.]+$/, '') || 'fit');
};

// ═══════════════════════════════════════════════════════════════════════════════
//  ADJUST MODULE
// ═══════════════════════════════════════════════════════════════════════════════
const ADJ_EXTS   = ['COA', 'BNP', 'PAR'];
const adjDropZone  = document.getElementById('adj-drop-zone');
const adjFileInput = document.getElementById('adj-file-input');

adjFileInput.onchange = e => handleAdjFiles([...e.target.files]);

let _adjDragDepth = 0;
adjDropZone.addEventListener('dragenter', e => { e.preventDefault(); _adjDragDepth++; adjDropZone.classList.add('over'); });
adjDropZone.addEventListener('dragover',  e => { e.preventDefault(); });
adjDropZone.addEventListener('dragleave', () => { if (--_adjDragDepth <= 0) { _adjDragDepth = 0; adjDropZone.classList.remove('over'); } });
adjDropZone.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  _adjDragDepth = 0;
  adjDropZone.classList.remove('over');
  const entries  = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const fallback = [...e.dataTransfer.files];
  const files = entries.length ? await processEntries(entries, ADJ_EXTS) : fallback;
  handleAdjFiles(files.length ? files : fallback);
});

function handleAdjFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toUpperCase();
    if (ADJ_EXTS.includes(ext)) ADJ.fileMap[ext] = f;
  }
  updateAdjFileBadges();
  document.getElementById('btn-adj-upload').disabled = !canUploadAdj();
}
function canUploadAdj() { return pyodideReady && ADJ_EXTS.every(e => ADJ.fileMap[e]); }

function updateAdjFileBadges() {
  const list = document.getElementById('adj-file-list');
  list.innerHTML = ADJ_EXTS.map(ext => {
    const ok = !!ADJ.fileMap[ext];
    return `<div class="file-badge"><div class="dot ${ok ? 'ok' : ''}"></div><span>${ext}</span><span style="color:var(--muted);margin-left:auto;font-size:.72rem">${ok ? ADJ.fileMap[ext].name : '未選取'}</span></div>`;
  }).join('');
}

document.getElementById('btn-adj-upload').onclick = async () => {
  if (!canUploadAdj()) return;
  setBtn('btn-adj-upload', true, '解析中…');
  progressShow('adj-progress');
  try {
    const bufs = {};
    for (const ext of ADJ_EXTS) bufs[ext] = await ADJ.fileMap[ext].arrayBuffer();
    worker.postMessage({
      type: 'adj_parse',
      payload: { coa: bufs['COA'], bnp: bufs['BNP'], par: bufs['PAR'] },
    }, [bufs['COA'], bufs['BNP'], bufs['PAR']]);
  } catch (err) {
    showToast('讀取失敗：' + err.message, true);
    setBtn('btn-adj-upload', false, '解析並顯示宗地');
    progressHide('adj-progress');
  }
};

function onAdjParsed(data) {
  progressHide('adj-progress');
  setBtn('btn-adj-upload', false, '解析並顯示宗地');
  ADJ.data   = data;
  ADJ.result = null;

  const allY = [], allX = [];
  for (const p of data.parcels) for (const [y, x] of (p.coords || [])) { allY.push(y); allX.push(x); }
  if (!allY.length) { showToast('未解析到宗地資料', true); return; }
  const pad = (Math.max(...allY) - Math.min(...allY)) * 0.05;
  extents = {
    minY: Math.min(...allY) - pad, maxY: Math.max(...allY) + pad,
    minX: Math.min(...allX) - pad, maxX: Math.max(...allX) + pad,
  };
  resizeCanvas(); initView();

  const exceedsCount = data.parcels.filter(p => p.exceeds).length;
  renderAdjParcelList(data.parcels);
  document.getElementById('adj-section').style.display = '';
  setBtn('btn-adj-run', false, '▶ 執行調整');
  showToast(`解析完成：${data.parcels.length} 宗地，其中 ${exceedsCount} 宗超出公差`);
  render();
}

function renderAdjParcelList(parcels) {
  const list = document.getElementById('adj-parcel-list');
  const items = parcels.filter(p => p.exceeds);
  if (!items.length) { list.innerHTML = '<div style="color:var(--green);font-size:.75rem">所有宗地均在公差內</div>'; return; }
  list.innerHTML = items.map(p => `
    <div class="parcel-row exceeds">
      <div class="status-dot"></div>
      <input type="checkbox" id="chk-${p.main}-${p.sub}" checked>
      <label for="chk-${p.main}-${p.sub}">${p.label}</label>
      <span style="margin-left:auto;color:var(--muted);font-size:.7rem">差${p.diff.toFixed(0)} m²/限${p.tol.toFixed(0)}</span>
    </div>`).join('');
}

document.getElementById('btn-adj-run').onclick = () => {
  if (!ADJ.data) return;
  const checked = ADJ.data.parcels.filter(p => {
    const chk = document.getElementById(`chk-${p.main}-${p.sub}`);
    return chk && chk.checked;
  }).map(p => [p.main, p.sub]);
  setBtn('btn-adj-run', true, '計算中…');
  progressShow('adj-progress');
  worker.postMessage({ type: 'adj_run', payload: { targetKeys: checked } });
};

function onAdjResult(result) {
  progressHide('adj-progress');
  setBtn('btn-adj-run', false, '▶ 執行調整');
  ADJ.result  = result;
  ADJ.coaText = result.coa_text;

  const list = document.getElementById('adj-result-list');
  list.innerHTML = result.adjusted_parcels.map(p => {
    const statusColor = p.status === 'ok' ? 'var(--green)' : 'var(--red)';
    return `<div style="border-bottom:1px solid #1e2030;padding:4px 0">
      <b>${p.label}</b> — 最大位移 ${p.max_shift_cm.toFixed(1)} cm (${p.mode})<br>
      面積差 ${p.diff_before.toFixed(2)} → <span style="color:${statusColor}">${p.diff_after.toFixed(2)}</span> m²
      (限 ±${p.tol.toFixed(2)} m²)
    </div>`;
  }).join('');
  document.getElementById('adj-result-section').style.display = '';
  document.getElementById('btn-adj-gpkg').style.display = '';
  document.getElementById('btn-adj-coa').style.display  = '';
  showToast(`調整完成：${result.adjusted_parcels.length} 宗地`);
  render();
}

document.getElementById('btn-adj-coa').onclick = () => {
  if (!ADJ.coaText) return;
  const blob = new Blob([new TextEncoder().encode(ADJ.coaText)], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'adjusted.COA'; a.click();
  URL.revokeObjectURL(url);
};

document.getElementById('btn-adj-gpkg').onclick = async () => {
  if (!ADJ.result) return;
  showToast('產生 GeoPackage…');
  await writeAdjGPKG(ADJ.result);
  showToast('GeoPackage 已下載');
};

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function exportCoordTXT(points, filename) {
  if (!points || !points.length) return;
  const rows = ['點號,N(m),E(m)', ...points.map((p, i) => `${i + 1},${p.y.toFixed(3)},${p.x.toFixed(3)}`)].join('\n');
  const blob = new Blob(['﻿' + rows], { type: 'text/plain;charset=utf-8' });
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${filename}_coords.txt`; a.click();
}

// ── GeoPackage writers (simple, uses sql.js via gpkg_writer.js) ──────────────
async function writeFitGPKG(fitResult, fitData, caseNo) {
  if (typeof writeGPKG !== 'function') { showToast('GeoPackage 模組未載入', true); return; }
  const points = (fitResult.fitted_boundary || []).map((p, i) => ({
    id: String(i + 1), y: p.y, x: p.x,
  }));
  const segs = fitResult.fitted_segments || [];
  await writeGPKG({
    filename: `${caseNo}_fit.gpkg`,
    points,
    segments: segs,
    metadata: {
      case_no: caseNo,
      theta_deg: fitResult.theta_deg,
      tx: fitResult.tx,
      ty: fitResult.ty,
      rmse_before: fitResult.stats?.rmse_before,
      rmse_after:  fitResult.stats?.rmse_after,
    },
  });
}

async function writeAdjGPKG(adjResult) {
  if (typeof writeGPKG !== 'function') { showToast('GeoPackage 模組未載入', true); return; }
  for (const p of adjResult.adjusted_parcels) {
    await writeGPKG({
      filename: `adj_${p.label}.gpkg`,
      polygons_before: p.coords_before,
      polygons_after:  p.coords_after,
      metadata: { parcel: p.label, diff_after: p.diff_after, tol: p.tol },
    });
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function setBtn(id, disabled, text) {
  const b = el(id); if (!b) return;
  b.disabled = disabled; b.textContent = text;
}

function setPyodideStatus(state, label) {
  const wrap  = el('pyodide-status');
  const lbl   = el('pyodide-label');
  wrap.className = state; lbl.textContent = label;
}

function progressShow(id) {
  const el_ = el(id); if (el_) el_.classList.add('visible');
}
function progressHide(id) {
  const el_ = el(id); if (el_) el_.classList.remove('visible');
}

let _toastTimer;
function showToast(msg, isError = false) {
  const t = el('toast');
  t.textContent = msg; t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Init ──────────────────────────────────────────────────────────────────────
resizeCanvas();
render();
updateFitFileBadges();
updateAdjFileBadges();
