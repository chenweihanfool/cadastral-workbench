/* ══════════════════════════════════════════════════════════════════════════
   CadastralWorkbench  app.js  v0.9
   純前端：Pyodide Worker + Canvas 渲染
   ══════════════════════════════════════════════════════════════════════════ */

// ── proj4 投影定義 (TWD67/EPSG:3828 → TWD97/EPSG:3826) ──────────────────────
// 參數來源：國土測繪中心，與 ka-tool 相同
proj4.defs('EPSG:3828',
  '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0' +
  ' +ellps=GRS67 +towgs84=-750.739,-359.515,-180.510,0,0,0,0 +units=m +no_defs');
proj4.defs('EPSG:3826',
  '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0' +
  ' +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

// twd67TM2 → twd97TM2：輸入/輸出都是 [N, E]（northing, easting）
function convertTwd67To97(N, E) {
  const [e97, n97] = proj4('EPSG:3828', 'EPSG:3826', [E, N]);
  return [n97, e97];
}

// ── 全域狀態 ─────────────────────────────────────────────────────────────────
const FIT = {
  data:       null,   // parse 結果（segments / ref_pts / boundary_pts / cy / cx）
  result:     null,   // fit 結果（fitted_segments / details / stats / …）
  weights:    {},     // {idx: weight}
  selectedPt: null,
  layers: { original: true, fitted: true, residuals: true, labels: true, boundary: true },
  fileMap:    {},     // {D14: File, D2C: File, D2D: File, D2B: File}
  crsIsWGS97: false,  // true after TWD67→TWD97 conversion
};

const ADJ = {
  data:       null,   // parse 結果（parcels）
  result:     null,   // adjust 結果
  layers:     { before: true, after: true, labels: true, regArea: true, calcArea: true, adjDiff: true, adjTol: true },
  fileMap:    {},     // {COA: File, BNP: File, PAR: File}
  coaText:    null,   // 調整後 COA 文字（下載用）
  crsIsWGS97: false,  // true after TWD67→TWD97 conversion
};

const JOIN = {
  data:    null,   // parse 結果（sheets / parcels / seam_report / stats）
  sheets:  {},     // { sheetId: {COA:File, BNP:File, PAR:File} }
  layers:  { parcels: true, bbox: true, seam: true },
};

const MANUAL = {
  active:     false,
  step:       0.01,        // metres per arrow-key press (default 1 cm)
  selections: [],          // [{ type:'point'|'edge'|'parcel', label, idx/i/j, y, x }, ...]
  hover:      null,
  coords:     {},          // label → [[y,x], ...]  working coordinates
  areas:      {},          // label → { area, reg, tol, diff, ok }
  history:    [],          // undo stack：每次移動前 push coords 快照（最多 80 步）
  baseline:   {},          // label → [[y,x], ...]  進入手動模式（或按重設）當下的快照，畫布上以虛線對照顯示
  relevantLabels: new Set(), // 本次自動調整過的宗地 + 拓樸上真正共用界址點的鄰地，畫布只對這些顯示完整標籤/較差資訊
};

const BASEMAP = { visible: false, opacity: 70, provider: 'google-hybrid' };

const TILE_PROVIDERS = {
  // Google (unofficial tile URLs — widely used in GIS but against Google ToS)
  'google-satellite': (z,x,y) => `https://mt0.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`,
  'google-hybrid':    (z,x,y) => `https://mt0.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}`,
  'google-map':       (z,x,y) => `https://mt0.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${z}`,
  // Esri World Imagery (官方免費，高解析度衛星)
  'esri-satellite':   (z,x,y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  // 國土測繪中心 (台灣政府官方，無 CORS 問題)
  'nlsc-photo': (z,x,y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`,
  'nlsc-map':   (z,x,y) => `https://wmts.nlsc.gov.tw/wmts/EMAP5/default/GoogleMapsCompatible/${z}/${y}/${x}`,
  // OpenStreetMap
  'osm':        (z,x,y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
};

const _tileCache = new Map();

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

function screenToWorld(sx, sy) {
  if (!extents) return null;
  return {
    x: (sx - view.tx) / view.scale + extents.minX,
    y: extents.maxY - (sy - view.ty) / view.scale,
  };
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

// ── 地號較差資訊文字字級：隨畫布縮放比例同步縮放（不再固定死在窄範圍），
// 並依文字所在位置離畫面中心的距離做衰減——放大到某地號時該地號多半在
// 畫面中央，文字會明顯放大方便閱讀；畫面邊緣的地號文字則不會等比放大到
// 爆版，維持地籍線為主體的畫面感。縮小時同理會跟著明顯縮小。
function scaledFontSize(baseMult, sx, sy, minPx, maxPx) {
  const raw = view.scale * baseMult;
  const clamped = Math.max(minPx, Math.min(maxPx, raw));
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  const t = Math.min(1, Math.hypot(sx - cx, sy - cy) / maxDist); // 0=中心 1=角落
  const falloff = 1 - 0.55 * t;
  return Math.max(minPx, clamped * falloff);
}

// ── TWD97/TM2 → WGS84 lat/lon (GRS80) ───────────────────────────────────────
const _GRS80_a   = 6378137.0;
const _GRS80_e2  = 2/298.257222101 - (1/298.257222101)**2;
const _TM2_CM    = Math.PI * 121 / 180;
const _TM2_K0    = 0.9999;
const _TM2_FE    = 250000;
const _TM2_FN    = 0;

function twd97ToLatLon(N, E) {
  const a = _GRS80_a, e2 = _GRS80_e2;
  const e4 = e2*e2, e6 = e2*e4;
  const e1 = (1 - Math.sqrt(1-e2)) / (1 + Math.sqrt(1-e2));
  const M  = (N - _TM2_FN) / _TM2_K0;
  const mu = M / (a*(1 - e2/4 - 3*e4/64 - 5*e6/256));
  const phi1 = mu
    + (3*e1/2 - 27*e1**3/32)*Math.sin(2*mu)
    + (21*e1**2/16 - 55*e1**4/32)*Math.sin(4*mu)
    + (151*e1**3/96)*Math.sin(6*mu)
    + (1097*e1**4/512)*Math.sin(8*mu);
  const n1  = a / Math.sqrt(1 - e2*Math.sin(phi1)**2);
  const r1  = a*(1-e2) / Math.pow(1 - e2*Math.sin(phi1)**2, 1.5);
  const t1  = Math.tan(phi1)**2;
  const c1  = e2/(1-e2)*Math.cos(phi1)**2;
  const D   = (E - _TM2_FE) / (n1*_TM2_K0);
  const lat = phi1 - (n1*Math.tan(phi1)/r1)*(D**2/2
    - (5+3*t1+10*c1-4*c1**2-9*e2/(1-e2))*D**4/24
    + (61+90*t1+298*c1+45*t1**2-252*e2/(1-e2)-3*c1**2)*D**6/720);
  const lon = _TM2_CM + (D - (1+2*t1+c1)*D**3/6
    + (5-2*c1+28*t1-3*c1**2+8*e2/(1-e2)+24*t1**2)*D**5/120) / Math.cos(phi1);
  return { lat: lat * 180/Math.PI, lon: lon * 180/Math.PI };
}

function latLonToTile(lat, lon, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1/Math.cos(latR)) / Math.PI) / 2 * n);
  return { x, y };
}

function tileNWLatLon(tx, ty, z) {
  const n = Math.pow(2, z);
  const lon = tx / n * 360 - 180;
  const latR = Math.atan(Math.sinh(Math.PI * (1 - 2*ty/n)));
  return { lat: latR * 180/Math.PI, lon };
}

// ── Basemap rendering ─────────────────────────────────────────────────────────
function renderBasemap() {
  if (!BASEMAP.visible || !extents) return;
  const W = canvas.width, H = canvas.height;

  // Viewport corners in world coords
  const sw = screenToWorld(0, H);
  const ne = screenToWorld(W, 0);
  if (!sw || !ne) return;

  // Convert to lat/lon (TWD97 assumed)
  const llSW = twd97ToLatLon(sw.y, sw.x);
  const llNE = twd97ToLatLon(ne.y, ne.x);

  const lonSpan = llNE.lon - llSW.lon;
  if (lonSpan <= 0) return;

  // Determine zoom
  const rawZ = Math.log2(360 / lonSpan * W / 256);
  const z = Math.max(14, Math.min(20, Math.round(rawZ)));

  // Tile range
  const tileSW = latLonToTile(llSW.lat, llSW.lon, z);
  const tileNE = latLonToTile(llNE.lat, llNE.lon, z);
  // tile x increases eastward  → SW has smaller x, NE has larger x
  // tile y increases southward → NE has smaller y, SW has larger y
  const txMin = Math.max(0, tileSW.x - 1);
  const txMax = Math.min(Math.pow(2, z) - 1, tileNE.x + 1);
  const tyMin = Math.max(0, tileNE.y - 1);
  const tyMax = Math.min(Math.pow(2, z) - 1, tileSW.y + 1);

  // Limit tile count to avoid flooding
  if ((txMax - txMin + 1) * (tyMax - tyMin + 1) > 64) return;

  const providerFn = TILE_PROVIDERS[BASEMAP.provider] || TILE_PROVIDERS['nlsc-photo'];
  const savedAlpha = ctx.globalAlpha;
  ctx.globalAlpha = BASEMAP.opacity / 100;

  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const key = `${z}/${tx}/${ty}/${BASEMAP.provider}`;
      const cached = _tileCache.get(key);

      if (cached === 'loading' || cached === 'error') continue;

      if (cached instanceof HTMLImageElement) {
        // Compute screen position of NW corner of tile
        const nw = tileNWLatLon(tx, ty, z);
        const se = tileNWLatLon(tx+1, ty+1, z);

        // Convert NW/SE lat-lon → TM2 N/E (approximate by inverting twd97ToLatLon)
        // We use a simple Mercator-based screen mapping instead:
        // Project via twd97ToLatLon inverse is expensive — use pixel math directly from
        // lat/lon → world-TM2 is not straightforward. Instead, compute screen px directly
        // from lat/lon using the known viewport mapping.
        const nwSx = ((nw.lon - llSW.lon) / lonSpan) * W;
        const seSx = ((se.lon - llSW.lon) / lonSpan) * W;
        const latSpan = llNE.lat - llSW.lat;
        const nwSy = ((llNE.lat - nw.lat) / latSpan) * H;
        const seSy = ((llNE.lat - se.lat) / latSpan) * H;
        const tw = seSx - nwSx;
        const th = seSy - nwSy;
        if (tw > 0 && th > 0) {
          ctx.drawImage(cached, nwSx, nwSy, tw, th);
        }
      } else {
        // Kick off fetch
        // Note: no crossOrigin — NLSC/OSM tiles don't send CORS headers.
        // Canvas becomes tainted but we only drawImage (never readPixels), so that's fine.
        _tileCache.set(key, 'loading');
        const url = providerFn(z, tx, ty);
        const img = new Image();
        img.onload = () => {
          _tileCache.set(key, img);
          render();
        };
        img.onerror = () => {
          // Don't permanently cache errors — allow retry on next render cycle
          _tileCache.delete(key);
        };
        img.src = url;
      }
    }
  }

  ctx.globalAlpha = savedAlpha;
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

  // Basemap is rendered first (behind everything)
  renderBasemap();

  if (activeTab === 'fit' || activeTab === 'crs' || activeTab === 'basemap') {
    renderFit(W, H);
  } else if (activeTab === 'join') {
    renderJoin(W, H);
  } else {
    renderAdj(W, H);
  }

  updateStatusBar();
}

function updateStatusBar() {
  const zoomEl  = document.getElementById('status-zoom');
  const modEl   = document.getElementById('status-module');
  if (zoomEl) zoomEl.textContent = '×' + view.scale.toFixed(2);
  const modNames = { fit: '套圖', adj: '調整', join: '接圖', crs: 'TWD97', basemap: '底圖' };
  if (modEl) modEl.textContent = modNames[activeTab] || activeTab;
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

  if (MANUAL.active) { renderAdjManual(W, H); return; }

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

  // 宗地標籤 + 面積資訊層
  const showExtra = ADJ.layers.regArea || ADJ.layers.calcArea || ADJ.layers.adjDiff || ADJ.layers.adjTol;
  if (ADJ.layers.labels || showExtra) {
    const adjMap = {};
    if (result) {
      for (const ap of result.adjusted_parcels) adjMap[`${ap.main}-${ap.sub}`] = ap;
    }
    ctx.textAlign = 'center';
    for (const p of parcels) {
      if (!p.coords || p.coords.length < 2) continue;
      const cy_ = p.coords.reduce((s, c) => s + c[0], 0) / p.coords.length;
      const cx_ = p.coords.reduce((s, c) => s + c[1], 0) / p.coords.length;
      const [sx, sy] = worldToScreen(cy_, cx_);
      const col = p.exceeds ? '#f05252' : '#3ecf6e';
      let yOff = 0;

      if (ADJ.layers.labels) {
        const labelFs = scaledFontSize(0.8, sx, sy, 6, 26);
        ctx.font = `${labelFs}px Consolas`;
        const tw = ctx.measureText(p.label).width;
        ctx.fillStyle = 'rgba(10,12,18,.7)';
        ctx.fillRect(sx - tw / 2 - 3, sy - labelFs * 0.7, tw + 6, labelFs + 4);
        ctx.fillStyle = col;
        ctx.fillText(p.label, sx, sy);
        yOff = labelFs + 5;
      }

      if (showExtra) {
        const ap = adjMap[p.label];
        const infoLines = [];
        if (ADJ.layers.regArea)  infoLines.push(`登記: ${p.reg.toFixed(2)} m²`);
        if (ADJ.layers.calcArea) infoLines.push(`計算: ${(ap ? ap.area_after : p.dig).toFixed(2)} m²`);
        if (ADJ.layers.adjDiff)  infoLines.push(`較差: ${(ap ? ap.diff_after : p.diff).toFixed(2)} m²`);
        if (ADJ.layers.adjTol)   infoLines.push(`公差: ±${p.tol.toFixed(2)} m²`);

        const infoFs = scaledFontSize(0.7, sx, sy, 5, 22);
        ctx.font = `${infoFs}px Consolas`;
        const lineH = infoFs + 4;
        infoLines.forEach((line, i) => {
          const tw2 = ctx.measureText(line).width;
          const lineY = sy + yOff + i * lineH;
          ctx.fillStyle = 'rgba(10,12,18,.75)';
          ctx.fillRect(sx - tw2 / 2 - 2, lineY - infoFs, tw2 + 4, infoFs + 3);
          ctx.fillStyle = '#b0b8c8';
          ctx.fillText(line, sx, lineY);
        });
      }
    }
  }
}

// ── 依分幅代號決定顏色（固定色盤，同一分幅每次都同色）───────────────────────
const _SHEET_PALETTE = ['#7aa2ff','#7ae0c4','#ffd27a','#ff9f7a','#c99bff','#7affea','#ffb3d1','#b3ff9b','#9bd1ff','#ffe08a'];
const _sheetColorCache = {};
function sheetColor(sheetId) {
  if (_sheetColorCache[sheetId]) return _sheetColorCache[sheetId];
  let h = 0;
  for (let i = 0; i < sheetId.length; i++) h = (h * 31 + sheetId.charCodeAt(i)) >>> 0;
  const col = _SHEET_PALETTE[h % _SHEET_PALETTE.length];
  _sheetColorCache[sheetId] = col;
  return col;
}

function renderJoin(W, H) {
  if (!JOIN.data) {
    drawPlaceholder(W, H, '請上傳多分幅地籍資料夾', 'COA · BNP · PAR（每個子資料夾一個分幅）');
    return;
  }

  if (JOIN.layers.bbox) {
    ctx.setLineDash([6, 4]);
    for (const s of JOIN.data.sheets) {
      if (!s.bbox) continue;
      const [minY, minX, maxY, maxX] = s.bbox;
      const [sx1, sy1] = worldToScreen(maxY, minX);
      const [sx2, sy2] = worldToScreen(minY, maxX);
      ctx.strokeStyle = 'rgba(245,197,66,.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      const labelFs = scaledFontSize(0.6, sx1, sy1, 8, 16);
      ctx.font = `${labelFs}px Consolas`;
      ctx.fillStyle = 'rgba(245,197,66,.9)';
      ctx.textAlign = 'left';
      ctx.fillText(s.id, sx1 + 3, sy1 + labelFs + 2);
    }
    ctx.setLineDash([]);
  }

  if (JOIN.layers.parcels) {
    for (const p of JOIN.data.parcels) {
      if (!p.coords || p.coords.length < 3) continue;
      drawPolygon(p.coords, _hexToRgba(sheetColor(p.sheet), 0.85), 1, false);
    }
  }

  if (JOIN.layers.seam && JOIN.data.seam_report) {
    for (const m of JOIN.data.seam_report.worst) {
      if (m.diff_m < 0.05) continue;
      const [sx, sy] = worldToScreen(m.y_a, m.x_a);
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240,82,82,.85)';
      ctx.fill();
    }
  }
}

function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawPolygon(coords, strokeColor, lineWidth, fill = true) {
  if (!coords || coords.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < coords.length; i++) {
    const [sx, sy] = worldToScreen(coords[i][0], coords[i][1]);
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
  } else {
    // Status bar coords
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx >= 0 && my >= 0 && mx <= canvas.width && my <= canvas.height) {
      const w = screenToWorld(mx, my);
      const coordEl = document.getElementById('status-coords');
      if (w && coordEl) {
        coordEl.textContent = `N: ${w.y.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}  E: ${w.x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
      }
    }
    if (activeTab === 'fit' && FIT.data) {
      handleFitHover(e);
    } else if (activeTab === 'adj' && MANUAL.active) {
      const rect2 = canvas.getBoundingClientRect();
      const newHover = hitTestManual(e.clientX - rect2.left, e.clientY - rect2.top);
      const prev = MANUAL.hover;
      const changed = (!!newHover !== !!prev) ||
        (newHover && prev && (newHover.type !== prev.type || newHover.label !== prev.label ||
                              newHover.idx !== prev.idx || newHover.i !== prev.i));
      if (changed) {
        MANUAL.hover = newHover;
        canvas.style.cursor = newHover ? 'crosshair' : 'grab';
        render();
      }
    }
  }
});
window.addEventListener('mouseup', e => {
  if (drag) {
    const moved = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy);
    drag = null;
    canvas.classList.remove('panning');
    if (moved < 4) {
      if (activeTab === 'fit') handleFitClick(e);
      else if (activeTab === 'adj' && MANUAL.active) handleAdjManualClick(e);
    }
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

function zoomToParcel(coords) {
  if (!coords || !coords.length || !extents) return;
  const ys = coords.map(c => c[0]);
  const xs = coords.map(c => c[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const padM = Math.max(maxX - minX, maxY - minY) * 0.3 + 5;
  const rX = (maxX - minX) + padM * 2 || 1;
  const rY = (maxY - minY) + padM * 2 || 1;
  const W = canvas.width - 80, H = canvas.height - 80;
  view.scale = Math.min(W / rX, H / rY);
  const cmy = (minY + maxY) / 2;
  const cmx = (minX + maxX) / 2;
  view.tx = canvas.width  / 2 - (cmx - extents.minX) * view.scale;
  view.ty = canvas.height / 2 - (extents.maxY - cmy) * view.scale;
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
const _adjExtraLayers = [
  { id: 'adj-layer-reg-area',  key: 'regArea'  },
  { id: 'adj-layer-calc-area', key: 'calcArea' },
  { id: 'adj-layer-diff',      key: 'adjDiff'  },
  { id: 'adj-layer-tol',       key: 'adjTol'   },
];
for (const { id, key } of _adjExtraLayers) {
  const el = document.getElementById(id);
  if (el) el.onchange = () => { ADJ.layers[key] = el.checked; render(); };
}

// ── 側邊欄面板切換（不影響畫布渲染的 activeTab）────────────────────────────
// showSidePanel: 只換側邊欄顯示的 tab-panel，畫布繼續渲染當前模組
function showSidePanel(tabName) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`tab-${tabName}`);
  if (panel) panel.classList.add('active');
  updateBasemapCrsWarn();
}

// ── 分頁切換（同時切換畫布渲染模組 + 側邊欄）────────────────────────────────
function switchTab(tabName) {
  activeTab = tabName;
  // Update toolbar tab buttons (only fit/adj are in toolbar now)
  document.querySelectorAll('.tb-btn[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  showSidePanel(tabName);
  if (extents) { initView(); render(); } else render();
}

document.querySelectorAll('.tb-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Panel collapse toggle ─────────────────────────────────────────────────────
(function () {
  const panel  = document.getElementById('side-panel');
  const toggle = document.getElementById('panel-toggle');
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▶' : '◀';
    setTimeout(() => resizeCanvas(), 220);
  });
})();

// ── Toolbar action buttons ────────────────────────────────────────────────────
document.getElementById('btn-download').onclick = () => {
  if (!FIT.result) return;
  exportCoordTXT(FIT.result.fitted_boundary, FIT.fileMap['D14']?.name?.replace(/\.[^.]+$/, '') || 'fit');
};
document.getElementById('btn-fit-gpkg').onclick = async () => {
  if (!FIT.result) return;
  showToast('產生 GeoPackage…');
  await writeFitGPKG(FIT.result, FIT.data, FIT.fileMap['D14']?.name?.replace(/\.[^.]+$/, '') || 'fit');
  showToast('GeoPackage 已下載');
};
// btn-changelog removed from toolbar; changelog opened via version badge click only

// ── Canvas quick-action buttons ───────────────────────────────────────────────
document.getElementById('btn-basemap-quick').onclick = () => {
  BASEMAP.visible = !BASEMAP.visible;
  // Sync checkbox in side panel
  const cb = document.getElementById('basemap-visible');
  if (cb) cb.checked = BASEMAP.visible;
  // Highlight button when active
  document.getElementById('btn-basemap-quick').classList.toggle('active', BASEMAP.visible);
  // Show basemap settings in side panel WITHOUT changing canvas module (activeTab unchanged)
  showSidePanel('basemap');
  render();  // re-render current module's canvas with/without basemap
};

document.getElementById('btn-crs-quick').onclick = () => {
  // 直接依畫布當前模組轉換，不切換 activeTab（畫布保持當前模組）
  startCrsConvert(activeTab === 'adj' ? 'adj' : 'fit');
  // 在側邊欄顯示 CRS 進度/結果，但不換畫布模組
  showSidePanel('crs');
};

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
      document.getElementById('btn-join-upload').disabled = !canUploadJoin();
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
    case 'join_parse_result':
      onJoinParsed(payload);
      break;
    case 'join_export_result':
      onJoinExportResult(payload);
      break;
    // crs_result no longer used — conversion done directly via proj4.js
    case 'error':
      showToast('錯誤：' + payload, true);
      progressHide('fit-progress');
      progressHide('adj-progress');
      progressHide('crs-progress');
      progressHide('join-progress');
      setBtn('btn-fit',        false, '▶ 執行套疊');
      setBtn('btn-adj-run',    false, '▶ 執行調整');
      setBtn('btn-crs-convert', false, '🔄 一鍵轉 TWD97');
      setBtn('btn-join-upload', false, '解析並合併');
      setBtn('btn-join-kc', false, '⬇ 匯出 COA/BNP/PAR');
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
  FIT.crsIsWGS97 = false;

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
  // Enable CRS convert buttons (side-panel + canvas quick)
  document.getElementById('btn-crs-convert').disabled = false;
  document.getElementById('btn-crs-quick').disabled = false;
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
  document.getElementById('btn-fit-send-adj').style.display = '';
  // Show toolbar buttons
  document.getElementById('btn-download').style.display = '';
  document.getElementById('btn-fit-gpkg').style.display = '';
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

// 送入調整模組
document.getElementById('btn-fit-send-adj').onclick = () => {
  if (!FIT.result) return;
  showToast('已切換至調整模組（尚需上傳 COA/BNP/PAR）');
  document.getElementById('adj-from-fit').style.display = '';
  switchTab('adj');
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
  // Enable CRS convert quick button for adj module
  document.getElementById('btn-crs-convert').disabled = false;
  document.getElementById('btn-crs-quick').disabled = false;
  showToast(`解析完成：${data.parcels.length} 宗地，其中 ${exceedsCount} 宗超出公差`);
  render();
}

function renderAdjParcelList(parcels) {
  const list = document.getElementById('adj-parcel-list');
  const items = parcels.filter(p => p.exceeds);
  if (!items.length) { list.innerHTML = '<div style="color:var(--green);font-size:.75rem">所有宗地均在公差內</div>'; return; }
  list.innerHTML = items.map(p => `
    <div class="parcel-row exceeds" data-main="${p.main}" data-sub="${p.sub}">
      <div class="status-dot"></div>
      <input type="checkbox" id="chk-${p.main}-${p.sub}">
      <label for="chk-${p.main}-${p.sub}">${p.label}</label>
      <span style="margin-left:auto;color:var(--muted);font-size:.7rem">差${p.diff.toFixed(0)} m²/公差${p.tol.toFixed(0)}</span>
    </div>`).join('');

  list.querySelectorAll('.parcel-row').forEach(row => {
    const main_ = parseInt(row.dataset.main, 10);
    const sub_  = parseInt(row.dataset.sub,  10);
    const p = parcels.find(q => q.main === main_ && q.sub === sub_);
    if (!p) return;
    row.querySelector('label').addEventListener('click', () => {
      if (p.coords && extents) zoomToParcel(p.coords);
    });
  });
}

document.getElementById('btn-adj-run').onclick = () => {
  if (!ADJ.data) return;
  const checked = ADJ.data.parcels.filter(p => {
    const chk = document.getElementById(`chk-${p.main}-${p.sub}`);
    return chk && chk.checked;
  }).map(p => [p.main, p.sub]);
  if (!checked.length) { showToast('請先勾選要調整的宗地', true); return; }
  const slider   = document.getElementById('max-shift-slider');
  const maxShiftM = (slider ? parseInt(slider.value, 10) : 30) / 100;
  setBtn('btn-adj-run', true, '計算中…');
  progressShow('adj-progress');
  worker.postMessage({ type: 'adj_run', payload: { targetKeys: checked, maxShiftM } });
};

function onAdjResult(result) {
  progressHide('adj-progress');
  setBtn('btn-adj-run', false, '▶ 執行調整');
  ADJ.result  = result;
  ADJ.coaText = result.coa_text;
  renderAdjResultList();
  document.getElementById('adj-result-section').style.display = '';
  document.getElementById('btn-adj-gpkg').style.display       = '';
  document.getElementById('btn-adj-coa').style.display        = '';
  document.getElementById('btn-manual-adj').style.display     = '';
  showToast(`調整完成：${result.adjusted_parcels.length} 宗地`);
  render();
}

function renderAdjResultList() {
  if (!ADJ.result) return;
  const list = document.getElementById('adj-result-list');
  list.innerHTML = ADJ.result.adjusted_parcels.map((p, idx) => {
    const sc = p.status === 'ok' ? 'var(--green)' : 'var(--red)';
    const manualBadge = p.manually_edited
      ? ` <span style="color:#f59e0b" title="含手動調整，額外位移 ${(p.manual_max_shift_cm || 0).toFixed(1)} cm">✏️ 手動 ${(p.manual_max_shift_cm || 0).toFixed(1)}cm</span>`
      : '';
    return `<div style="border-bottom:1px solid #1e2030;padding:4px 0">
      <div style="display:flex;align-items:flex-start;gap:4px">
        <div style="flex:1;min-width:0;font-size:.88rem;line-height:1.8">
          <b>${p.label}</b> — 最大位移 ${p.max_shift_cm.toFixed(1)} cm (${p.mode})${manualBadge}<br>
          面積差 ${p.diff_before.toFixed(2)} → <span style="color:${sc}">${p.diff_after.toFixed(2)}</span> m²
          (公差 ±${p.tol.toFixed(2)} m²)
        </div>
        <button class="btn-tiny btn-dxf-dl" data-idx="${idx}" title="下載 DXF" style="flex-shrink:0;margin-top:3px">📐</button>
        <button class="btn-tiny btn-pdf-dl" data-idx="${idx}" title="下載調整報告 PDF" style="flex-shrink:0;margin-top:3px">📄</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-dxf-dl').forEach(btn => {
    btn.onclick = () => {
      const p = ADJ.result.adjusted_parcels[parseInt(btn.dataset.idx, 10)];
      if (!p) return;
      const dxf = writeParcelDXF(p);
      if (!dxf) { showToast('DXF 產生失敗：缺少座標資料', true); return; }
      const blob = new Blob([dxf], { type: 'application/dxf' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `adj_${p.label}.dxf`; a.click();
      URL.revokeObjectURL(url);
      showToast(`已下載：adj_${p.label}.dxf`);
    };
  });

  list.querySelectorAll('.btn-pdf-dl').forEach(btn => {
    btn.onclick = () => {
      const p = ADJ.result.adjusted_parcels[parseInt(btn.dataset.idx, 10)];
      if (p) generateParcelPDF(p);
    };
  });
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
//  JOIN MODULE — 接圖（多分幅 COA/BNP/PAR 合併）
// ═══════════════════════════════════════════════════════════════════════════════
const JOIN_EXTS = ['COA', 'BNP', 'PAR'];
const joinDropZone  = document.getElementById('join-drop-zone');
const joinFileInput = document.getElementById('join-file-input');

// 依檔案相對路徑分組：上層資料夾/分幅子資料夾/檔案，分幅代號＝該檔案的直接父資料夾名稱
function groupJoinFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toUpperCase();
    if (!JOIN_EXTS.includes(ext)) continue;
    const relPath = f.webkitRelativePath || f._joinRelPath || '';
    const parts = relPath.split('/').filter(Boolean);
    if (parts.length < 2) continue; // 沒有子資料夾層級，無法判斷屬於哪個分幅
    const sheetId = parts[parts.length - 2];
    if (!JOIN.sheets[sheetId]) JOIN.sheets[sheetId] = {};
    JOIN.sheets[sheetId][ext] = f;
  }
  updateJoinSheetList();
  document.getElementById('btn-join-upload').disabled = !canUploadJoin();
}

async function processEntriesWithPath(entries, extensions) {
  const extSet  = new Set(extensions.map(e => e.toUpperCase()));
  const results = [];
  async function walk(entry) {
    if (entry.isFile) {
      const ext = entry.name.split('.').pop().toUpperCase();
      if (extSet.has(ext)) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file._joinRelPath = entry.fullPath.replace(/^\//, '');
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

joinFileInput.onchange = e => groupJoinFiles([...e.target.files]);

let _joinDragDepth = 0;
joinDropZone.addEventListener('dragenter', e => { e.preventDefault(); _joinDragDepth++; joinDropZone.classList.add('over'); });
joinDropZone.addEventListener('dragover',  e => { e.preventDefault(); });
joinDropZone.addEventListener('dragleave', () => { if (--_joinDragDepth <= 0) { _joinDragDepth = 0; joinDropZone.classList.remove('over'); } });
joinDropZone.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  _joinDragDepth = 0;
  joinDropZone.classList.remove('over');
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) { showToast('瀏覽器不支援資料夾拖放，請改用點擊選取', true); return; }
  const files = await processEntriesWithPath(entries, JOIN_EXTS);
  groupJoinFiles(files);
});

function canUploadJoin() {
  if (!pyodideReady) return false;
  return Object.values(JOIN.sheets).some(s => s.COA && s.BNP);
}

function updateJoinSheetList() {
  const list = document.getElementById('join-sheet-list');
  const ids = Object.keys(JOIN.sheets).sort();
  if (!ids.length) { list.innerHTML = ''; return; }
  list.innerHTML = ids.map(id => {
    const s = JOIN.sheets[id];
    const ok = !!(s.COA && s.BNP);
    const parts = JOIN_EXTS.map(ext => `<span style="color:${s[ext] ? 'var(--green)' : 'var(--muted)'};margin-right:6px">${ext}${s[ext] ? '✓' : ''}</span>`).join('');
    return `<div class="file-badge"><div class="dot ${ok ? 'ok' : ''}"></div><span>${id}</span><span style="margin-left:auto;font-size:.72rem">${parts}</span></div>`;
  }).join('');
}

document.getElementById('btn-join-upload').onclick = async () => {
  if (!canUploadJoin()) return;
  setBtn('btn-join-upload', true, '解析中…');
  progressShow('join-progress');
  try {
    const sheetIds = Object.keys(JOIN.sheets).filter(id => JOIN.sheets[id].COA && JOIN.sheets[id].BNP).sort();
    const skipped  = Object.keys(JOIN.sheets).length - sheetIds.length;
    if (skipped > 0) showToast(`${skipped} 個分幅缺少 COA/BNP，已略過`, true);
    const sheets = [];
    const transfers = [];
    for (const id of sheetIds) {
      const s = JOIN.sheets[id];
      const coa = await s.COA.arrayBuffer();
      const bnp = await s.BNP.arrayBuffer();
      const par = s.PAR ? await s.PAR.arrayBuffer() : null;
      sheets.push({ id, coa, bnp, par });
      transfers.push(coa, bnp);
      if (par) transfers.push(par);
    }
    worker.postMessage({ type: 'join_parse', payload: { sheets } }, transfers);
  } catch (err) {
    showToast('讀取失敗：' + err.message, true);
    setBtn('btn-join-upload', false, '解析並合併');
    progressHide('join-progress');
  }
};

function onJoinParsed(data) {
  progressHide('join-progress');
  setBtn('btn-join-upload', false, '解析並合併');
  JOIN.data = data;

  const allY = [], allX = [];
  for (const p of data.parcels) for (const [y, x] of (p.coords || [])) { allY.push(y); allX.push(x); }
  if (!allY.length) { showToast('未解析到任何地號幾何', true); return; }
  const pad = (Math.max(...allY) - Math.min(...allY)) * 0.03;
  extents = {
    minY: Math.min(...allY) - pad, maxY: Math.max(...allY) + pad,
    minX: Math.min(...allX) - pad, maxX: Math.max(...allX) + pad,
  };
  resizeCanvas(); initView();

  el('join-stat-sheets').textContent  = data.stats.n_sheets;
  el('join-stat-parcels').textContent = data.stats.n_parcels;
  el('join-stat-points').textContent  = data.stats.n_points;
  document.getElementById('join-stats-section').style.display = '';

  renderJoinSeamReport(data.seam_report);
  document.getElementById('join-seam-section').style.display = '';
  document.getElementById('btn-join-gpkg').style.display    = '';
  document.getElementById('btn-join-geojson').style.display = '';
  document.getElementById('btn-join-kc').style.display      = '';
  document.getElementById('join-renumber-note').style.display = 'none';

  if (data.warnings && data.warnings.length) {
    showToast(data.warnings.join('；'), true);
  }
  showToast(`合併完成：${data.stats.n_sheets} 個分幅、${data.stats.n_parcels} 筆地號`);
  render();
}

function renderJoinSeamReport(seam) {
  const bins = seam.bins || {};
  const binsEl = document.getElementById('join-seam-bins');
  const binLabels = { exact: '完全重合', le_5cm: '≤5cm', le_10cm: '5-10cm', le_30cm: '10-30cm', le_50cm: '30-50cm' };
  binsEl.innerHTML = Object.entries(binLabels).map(([k, label]) => {
    const isBad = k !== 'exact' && k !== 'le_5cm' && (bins[k] || 0) > 0;
    return `<div class="stat-box"><div class="label">${label}</div><div class="value" style="${isBad ? 'color:var(--red)' : ''}">${bins[k] || 0}</div></div>`;
  }).join('');

  const listEl = document.getElementById('join-seam-list');
  const worst = (seam.worst || []).filter(m => m.diff_m >= 0.05);
  if (!worst.length) {
    listEl.innerHTML = '<div style="color:var(--green)">未發現超過 5 cm 的共邊座標微差</div>';
    return;
  }
  listEl.innerHTML = worst.slice(0, 30).map(m => `
    <div style="border-bottom:1px solid #1e2030;padding:3px 0;cursor:pointer" class="join-seam-row" data-y="${m.y_a}" data-x="${m.x_a}">
      <b style="color:var(--red)">${m.diff_m.toFixed(3)} m</b> —
      ${m.sheet_a}#${m.pt_a} ↔ ${m.sheet_b}#${m.pt_b}
    </div>`).join('');
  listEl.querySelectorAll('.join-seam-row').forEach(row => {
    row.addEventListener('click', () => {
      const y = parseFloat(row.dataset.y), x = parseFloat(row.dataset.x);
      if (!extents) return;
      const span = 20; // 公尺
      extents = { minY: y - span, maxY: y + span, minX: x - span, maxX: x + span };
      resizeCanvas(); initView(); render();
    });
  });
}

['join-layer-parcels', 'join-layer-bbox', 'join-layer-seam'].forEach(id => {
  const key = id.replace('join-layer-', '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  document.getElementById(id).addEventListener('change', e => {
    JOIN.layers[key] = e.target.checked;
    render();
  });
});

document.getElementById('btn-join-gpkg').onclick = async () => {
  if (!JOIN.data) return;
  showToast('產生 GeoPackage…');
  await writeJoinGPKG(JOIN.data);
  showToast('GeoPackage 已下載');
};

document.getElementById('btn-join-geojson').onclick = () => {
  if (!JOIN.data) return;
  const features = JOIN.data.parcels.map(p => ({
    type: 'Feature',
    properties: {
      sheet: p.sheet, sec: p.sec, sub: p.sub, label: p.label,
      area_reg: p.area_reg, area_calc: p.area_calc, area_geom: p.area_geom,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[...p.coords.map(([y, x]) => [x, y]), [p.coords[0][1], p.coords[0][0]]]],
    },
  }));
  const geojson = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3826' } },
    features,
  };
  const blob = new Blob([JSON.stringify(geojson)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'joined_cadastral.geojson'; a.click();
  showToast('GeoJSON 已下載');
};

document.getElementById('btn-join-kc').onclick = () => {
  if (!JOIN.data) return;
  setBtn('btn-join-kc', true, '產生中…');
  worker.postMessage({ type: 'join_export' });
};

function onJoinExportResult(result) {
  setBtn('btn-join-kc', false, '⬇ 匯出 COA/BNP/PAR');
  if (result.error) { showToast(result.error, true); return; }

  const dl = (text, filename) => {
    const blob = new Blob([new TextEncoder().encode(text)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  };
  dl(result.coa_text, 'JOINED.COA');
  dl(result.bnp_text, 'JOINED.BNP');
  dl(result.par_text, 'JOINED.PAR');

  const noteEl = document.getElementById('join-renumber-note');
  if (result.renumbered && result.renumbered.length) {
    const sample = result.renumbered.slice(0, 8)
      .map(r => `${r.sheet} (${r.old_sec}-${r.old_sub}) → (${r.new_sec}-${r.new_sub})`).join('<br>');
    const more = result.renumbered.length > 8 ? `<br>…等共 ${result.renumbered.length} 筆` : '';
    noteEl.innerHTML = `⚠ ${result.renumbered.length} 筆地號因跨分幅段/小段撞號已調整編號：<br>${sample}${more}`;
    noteEl.style.display = '';
  } else {
    noteEl.style.display = 'none';
  }
  showToast(`已下載合併後 COA/BNP/PAR（${result.stats.n_points} 點、${result.stats.n_parcels} 宗地）`);
}

async function writeJoinGPKG(data) {
  if (typeof writeGPKG !== 'function') { showToast('GeoPackage 模組未載入', true); return; }
  await writeGPKG({
    filename: 'joined_cadastral.gpkg',
    joined_parcels: data.parcels,
    metadata: {
      n_sheets: data.stats.n_sheets,
      n_parcels: data.stats.n_parcels,
      n_points: data.stats.n_points,
      seam_matched_pairs: data.seam_report?.n_matched_pairs || 0,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CRS MODULE (TWD67 → TWD97)  ── 直接用 proj4.js，不走 Pyodide worker
// ═══════════════════════════════════════════════════════════════════════════════

function startCrsConvert(source) {
  if (source === 'adj') {
    if (!ADJ.data) { showToast('請先載入調整資料', true); return; }
    if (ADJ.crsIsWGS97) { showToast('已是 TWD97 座標，無需重複轉換'); return; }
    _applyCrsAdj();
  } else {
    if (!FIT.data) { showToast('請先載入套圖資料', true); return; }
    if (FIT.crsIsWGS97) { showToast('已是 TWD97 座標，無需重複轉換'); return; }
    _applyCrsFit();
  }
}

function _applyCrsFit() {
  // ── build unique-point lookup ──────────────────────────────────────────────
  const convMap = new Map();
  const _conv = (y, x) => {
    const key = `${y.toFixed(6)}:${x.toFixed(6)}`;
    if (!convMap.has(key)) {
      const [n97, e97] = convertTwd67To97(y, x);
      convMap.set(key, [n97, e97]);
    }
    return convMap.get(key);
  };

  let sumDn = 0, sumDe = 0, cnt = 0;
  for (const p of FIT.data.ref_pts) {
    const [n97, e97] = _conv(p.y, p.x);
    sumDn += n97 - p.y; sumDe += e97 - p.x; cnt++;
    p.y = n97; p.x = e97;
  }
  for (const p of FIT.data.boundary_pts) {
    const [n97, e97] = _conv(p.y, p.x);
    p.y = n97; p.x = e97;
  }
  FIT.data.segments = FIT.data.segments.map(([y1, x1, y2, x2]) => {
    const c1 = _conv(y1, x1);
    const c2 = _conv(y2, x2);
    return [c1[0], c1[1], c2[0], c2[1]];
  });

  const allY = [], allX = [];
  for (const [y1,x1,y2,x2] of FIT.data.segments) { allY.push(y1,y2); allX.push(x1,x2); }
  for (const p of FIT.data.ref_pts)      { allY.push(p.y); allX.push(p.x); }
  for (const p of FIT.data.boundary_pts) { allY.push(p.y); allX.push(p.x); }
  const pad = (Math.max(...allY) - Math.min(...allY)) * 0.05;
  extents = { minY: Math.min(...allY)-pad, maxY: Math.max(...allY)+pad,
              minX: Math.min(...allX)-pad, maxX: Math.max(...allX)+pad };

  FIT.crsIsWGS97 = true;
  FIT.result = null;
  _finishCrs(sumDn/cnt, sumDe/cnt, cnt);
}

function _applyCrsAdj() {
  const convMap = new Map();
  const _conv = (y, x) => {
    const key = `${y.toFixed(6)}:${x.toFixed(6)}`;
    if (!convMap.has(key)) {
      const [n97, e97] = convertTwd67To97(y, x);
      convMap.set(key, [n97, e97]);
    }
    return convMap.get(key);
  };

  let sumDn = 0, sumDe = 0, cnt = 0;
  for (const parcel of ADJ.data.parcels) {
    parcel.coords = parcel.coords.map(([y, x]) => {
      const [n97, e97] = _conv(y, x);
      sumDn += n97 - y; sumDe += e97 - x; cnt++;
      return [n97, e97];
    });
  }
  if (ADJ.result) {
    const applyArr = arr => arr.map(([y, x]) => _conv(y, x));
    for (const p of ADJ.result.adjusted_parcels) {
      if (p.coords_before) p.coords_before = applyArr(p.coords_before);
      if (p.coords_after)  p.coords_after  = applyArr(p.coords_after);
    }
  }

  const allY = [], allX = [];
  for (const parcel of ADJ.data.parcels)
    for (const [y, x] of parcel.coords) { allY.push(y); allX.push(x); }
  const pad2 = (Math.max(...allY) - Math.min(...allY)) * 0.05;
  extents = { minY: Math.min(...allY)-pad2, maxY: Math.max(...allY)+pad2,
              minX: Math.min(...allX)-pad2, maxX: Math.max(...allX)+pad2 };

  ADJ.crsIsWGS97 = true;
  _finishCrs(sumDn/cnt, sumDe/cnt, cnt);
}

function _finishCrs(meanDn, meanDe, count) {
  const resEl = document.getElementById('crs-result-section');
  document.getElementById('crs-dn').textContent    = (meanDn >= 0 ? '+' : '') + meanDn.toFixed(3) + ' m';
  document.getElementById('crs-de').textContent    = (meanDe >= 0 ? '+' : '') + meanDe.toFixed(3) + ' m';
  document.getElementById('crs-count').textContent = count + ' 點';
  resEl.style.display = '';

  const badge = document.getElementById('crs-from-badge');
  if (badge) { badge.textContent = 'TWD97'; badge.className = 'crs-badge twd97'; }

  const quickBtn = document.getElementById('btn-crs-quick');
  if (quickBtn) { quickBtn.disabled = true; quickBtn.title = '已是 TWD97 座標'; }

  setBtn('btn-crs-convert', false, '🔄 一鍵轉 TWD97');
  updateBasemapCrsWarn();
  resizeCanvas(); initView(); render();
  showToast('TWD67→TWD97 轉換完成');
}

document.getElementById('btn-crs-convert').onclick = () => {
  startCrsConvert(activeTab === 'adj' ? 'adj' : 'fit');
};

// ═══════════════════════════════════════════════════════════════════════════════
//  BASEMAP MODULE
// ═══════════════════════════════════════════════════════════════════════════════
function updateBasemapCrsWarn() {
  const warn = document.getElementById('basemap-crs-warn');
  if (!warn) return;
  warn.style.display = (FIT.data && !FIT.crsIsWGS97) ? '' : 'none';
}

(function () {
  const visEl    = document.getElementById('basemap-visible');
  const opacEl   = document.getElementById('basemap-opacity');
  const opacVal  = document.getElementById('basemap-opacity-val');

  if (visEl) visEl.onchange = () => {
    BASEMAP.visible = visEl.checked;
    render();
  };
  if (opacEl) opacEl.oninput = () => {
    BASEMAP.opacity = parseInt(opacEl.value, 10);
    if (opacVal) opacVal.textContent = BASEMAP.opacity + '%';
    render();
  };

  document.querySelectorAll('input[name="basemap-src"]').forEach(radio => {
    radio.onchange = () => {
      if (radio.checked) {
        BASEMAP.provider = radio.value;
        // Clear tile cache for old provider
        for (const key of [..._tileCache.keys()]) {
          if (!key.endsWith('/' + BASEMAP.provider)) _tileCache.delete(key);
        }
        render();
      }
    };
  });
})();

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

// ── Changelog ─────────────────────────────────────────────────────────────────
function openChangelog() {
  const modal = el('changelog-modal');
  const body  = el('changelog-body');
  if (!modal || !body) return;
  const entries = (window.CHANGELOG || []);
  body.innerHTML = entries.length ? entries.map(e => `
    <div class="cl-entry">
      <div class="cl-head">
        <span class="cl-tag">${e.version}</span>
        <span class="cl-date">${e.date || ''}</span>
      </div>
      <ul class="cl-notes">${(e.notes || []).map(n => `<li>${n}</li>`).join('')}</ul>
    </div>`).join('')
    : '<div style="color:var(--muted)">（無日誌資料）</div>';
  modal.style.display = 'flex';
}
document.getElementById('changelog-close').onclick = () => {
  const modal = el('changelog-modal');
  if (modal) modal.style.display = 'none';
};

// ── 全域攔截：防止瀏覽器對拖放執行預設「開啟/瀏覽」行為 ─────────────────────
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop',     e => e.preventDefault());

// ── 調整模組：工具列按鈕 ───────────────────────────────────────────────────────
document.getElementById('btn-adj-chk-all').onclick = () => {
  document.querySelectorAll('#adj-parcel-list input[type=checkbox]').forEach(cb => { cb.checked = true; });
};
document.getElementById('btn-adj-chk-none').onclick = () => {
  document.querySelectorAll('#adj-parcel-list input[type=checkbox]').forEach(cb => { cb.checked = false; });
};

// ── 最大調整幅度滑桿 ──────────────────────────────────────────────────────────
(function () {
  const slider = document.getElementById('max-shift-slider');
  const label  = document.getElementById('max-shift-val');
  if (slider && label) {
    slider.oninput = () => { label.textContent = slider.value + ' cm'; };
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  MANUAL ADJUSTMENT MODULE
// ═══════════════════════════════════════════════════════════════════════════════

// ── 幾何輔助 ─────────────────────────────────────────────────────────────────
function shoelaceArea(coords) {
  const n = coords.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += coords[i][0] * coords[j][1] - coords[j][0] * coords[i][1];
  }
  return Math.abs(a) / 2;
}

function pointInPolygon(py, px, coords) {
  let inside = false;
  const n = coords.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, xi] = coords[i];
    const [yj, xj] = coords[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegPx(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ── HitTest ──────────────────────────────────────────────────────────────────
function hitTestManual(mx, my) {
  if (!MANUAL.active) return null;
  const PT_THRESH  = 10;  // px
  const SEG_THRESH = 8;   // px

  // 1. 界址點優先
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    for (let idx = 0; idx < coords.length; idx++) {
      const [sx, sy] = worldToScreen(coords[idx][0], coords[idx][1]);
      if (Math.hypot(mx - sx, my - sy) <= PT_THRESH) {
        return { type: 'point', label, idx, y: coords[idx][0], x: coords[idx][1] };
      }
    }
  }

  // 2. 邊線
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    const n = coords.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [sx1, sy1] = worldToScreen(coords[i][0], coords[i][1]);
      const [sx2, sy2] = worldToScreen(coords[j][0], coords[j][1]);
      if (distToSegPx(mx, my, sx1, sy1, sx2, sy2) <= SEG_THRESH) {
        return { type: 'edge', label, i, j };
      }
    }
  }

  // 3. 整筆宗地（面）
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    if (!extents) continue;
    const wy = extents.maxY - (my - view.ty) / view.scale;
    const wx = (mx - view.tx) / view.scale + extents.minX;
    if (pointInPolygon(wy, wx, coords)) {
      return { type: 'parcel', label };
    }
  }

  return null;
}

// ── 初始化 MANUAL.coords ────────────────────────────────────────────────────
function initManualCoords() {
  MANUAL.coords = {};
  MANUAL.areas  = {};
  if (!ADJ.result) return;

  if (ADJ.data) {
    for (const p of ADJ.data.parcels) {
      if (p.coords) MANUAL.coords[p.label] = p.coords.map(c => [c[0], c[1]]);
    }
  }

  for (const p of ADJ.result.adjusted_parcels) {
    MANUAL.coords[p.label] = p.coords_after.map(c => [c[0], c[1]]);
  }

  // relevantLabels：本次自動調整過的宗地 + 實際共用界址點的鄰地（拓樸上真正相鄰，
  // 不是「畫面上剛好在附近」）。畫布只對這些宗地顯示完整標籤/較差資訊，
  // 避免資料密集區域（一個小範圍內幾十甚至上百筆宗地）縮放進去後全部標籤擠在一起
  const adjKeys = new Set(ADJ.result.adjusted_parcels.map(p => p.label));
  MANUAL.relevantLabels = new Set(adjKeys);

  for (const ap of ADJ.result.adjusted_parcels) {
    const n = Math.min(ap.coords_before.length, ap.coords_after.length);
    for (let i = 0; i < n; i++) {
      const [by, bx] = ap.coords_before[i];
      const [ay, ax] = ap.coords_after[i];
      if (Math.abs(ay - by) < 1e-9 && Math.abs(ax - bx) < 1e-9) continue;
      for (const [label, coords] of Object.entries(MANUAL.coords)) {
        if (adjKeys.has(label)) continue;
        for (let k = 0; k < coords.length; k++) {
          if (Math.abs(coords[k][0] - by) < EPS_SHARE && Math.abs(coords[k][1] - bx) < EPS_SHARE) {
            coords[k] = [ay, ax];
            MANUAL.relevantLabels.add(label);
          }
        }
      }
    }
  }

  updateManualAreas();
  // 快照目前狀態作為畫布上的虛線對照基準（此後手動移動只更新 coords，不動 baseline）
  MANUAL.baseline = {};
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    MANUAL.baseline[label] = coords.map(c => [c[0], c[1]]);
  }
}

function updateManualAreas() {
  if (!ADJ.data) return;
  const regMap = {}, tolMap = {};
  for (const p of ADJ.data.parcels) {
    regMap[p.label] = p.reg;
    tolMap[p.label] = p.tol;
  }
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    const area = shoelaceArea(coords);
    const reg  = regMap[label] ?? area;
    const tol  = tolMap[label] ?? 0;
    const diff = reg - area;
    MANUAL.areas[label] = { area, reg, tol, diff, ok: Math.abs(diff) <= tol };
  }
}

function enterManualMode() {
  initManualCoords();
  MANUAL.active     = true;
  MANUAL.selections = [];
  MANUAL.history    = [];
  MANUAL.hover      = null;
  MANUAL.step       = parseFloat(document.getElementById('manual-step')?.value ?? '0.01');

  // 自動縮放到本次自動調整過的宗地：資料筆數多時（例如整個地段上千筆宗地）畫面若還停在
  // 全域縮放比例，這幾筆宗地會小到只剩幾像素——標籤/較差資訊文字全部擠在一起看不清楚，
  // 且點擊選取的判定半徑（螢幕 10px）換算成實際距離會涵蓋到隔壁完全不同的宗地，
  // 導致以為在調整這筆卻誤選、誤動到鄰地的界址點。進入手動模式時先框選這幾筆宗地，
  // 才能看清楚資訊、精準點選。
  if (ADJ.result && ADJ.result.adjusted_parcels.length) {
    const allPts = [];
    for (const ap of ADJ.result.adjusted_parcels) {
      const c = MANUAL.coords[ap.label];
      if (c) allPts.push(...c);
    }
    if (allPts.length) zoomToParcel(allPts);
  }

  const tb = document.getElementById('manual-toolbar');
  if (tb) tb.style.display = 'flex';
  const ht = document.getElementById('hint');
  if (ht) ht.style.display = 'none';
  const si = document.getElementById('manual-sel-info');
  if (si) si.textContent = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
  render();
}

/** 兩組對應點座標間的最大位移量（公分）。點數/順序不一致時回傳 0（無法比較）。 */
function _maxShiftCm(coordsA, coordsB) {
  if (!coordsA || !coordsB || coordsA.length !== coordsB.length) return 0;
  let max = 0;
  for (let i = 0; i < coordsA.length; i++) {
    const d = Math.hypot(coordsA[i][0] - coordsB[i][0], coordsA[i][1] - coordsB[i][1]);
    if (d > max) max = d;
  }
  return max * 100;
}

function exitManualMode(apply) {
  if (apply && ADJ.result) {
    const adjMap = {};
    for (const ap of ADJ.result.adjusted_parcels) adjMap[ap.label] = ap;
    let changedCount = 0;

    for (const [label, liveCoords] of Object.entries(MANUAL.coords)) {
      const baseCoords = MANUAL.baseline[label];
      if (!_coordsChanged(baseCoords, liveCoords)) continue; // 本次手動模式沒動過這筆，略過
      changedCount++;
      const ma = MANUAL.areas[label];
      let ap = adjMap[label];

      if (ap) {
        // 原本就是自動調整過的宗地：保留第一次的「純自動調整結果」供報表對照，
        // 之後多次手動調整只累加位移，不覆蓋這個基準
        if (!ap.coords_after_auto) ap.coords_after_auto = ap.coords_after.map(c => [c[0], c[1]]);
        ap.manual_max_shift_cm = _maxShiftCm(ap.coords_after_auto, liveCoords);
        ap.coords_after = liveCoords.map(c => [c[0], c[1]]);
        if (ma) { ap.area_after = ma.area; ap.diff_after = ma.diff; ap.status = ma.ok ? 'ok' : 'still_over'; }
        ap.manually_edited = true;
      } else {
        // 原本在公差內、Python 沒有調整過，但使用者手動調整了：補一筆進調整結果，
        // 否則這個變動只存在畫布上，離開手動模式後就不見了
        const p = ADJ.data.parcels.find(q => q.label === label);
        if (!p || !p.coords) continue;
        const areaBefore = shoelaceArea(p.coords);
        const newAp = {
          main: p.main, sub: p.sub, label: p.label,
          coords_before:     p.coords.map(c => [c[0], c[1]]),
          coords_after_auto: p.coords.map(c => [c[0], c[1]]),
          coords_after:      liveCoords.map(c => [c[0], c[1]]),
          reg: p.reg, area_before: areaBefore, area_after: ma ? ma.area : areaBefore,
          diff_before: p.reg - areaBefore, diff_after: ma ? ma.diff : (p.reg - areaBefore),
          tol: p.tol, max_shift_cm: 0,
          manual_max_shift_cm: _maxShiftCm(p.coords, liveCoords),
          mode: 'manual_only', status: ma ? (ma.ok ? 'ok' : 'still_over') : 'still_over',
          manually_edited: true,
        };
        ADJ.result.adjusted_parcels.push(newAp);
      }
    }

    renderAdjResultList();
    showToast(changedCount ? `手動調整已套用（${changedCount} 筆宗地）` : '本次未變更任何座標');
  }
  MANUAL.active     = false;
  MANUAL.selections = [];
  MANUAL.history    = [];
  MANUAL.hover      = null;
  const tb2 = document.getElementById('manual-toolbar');
  if (tb2) tb2.style.display = 'none';
  const ht2 = document.getElementById('hint');
  if (ht2) ht2.style.display = '';
  canvas.style.cursor = 'grab';
  render();
}

function handleAdjManualClick(e) {
  const rect = canvas.getBoundingClientRect();
  const hit  = hitTestManual(e.clientX - rect.left, e.clientY - rect.top);
  const info = document.getElementById('manual-sel-info');
  const ctrl = e.ctrlKey || e.metaKey;

  if (!hit) {
    MANUAL.selections = [];
    info.textContent  = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
    render();
    return;
  }

  if (ctrl && MANUAL.selections.length > 0) {
    const existType = MANUAL.selections[0].type;
    if (hit.type !== existType) {
      info.textContent = `⚠ 複選限同類（目前：${existType}）`;
      render();
      return;
    }
    const key = selKey(hit);
    const idx = MANUAL.selections.findIndex(s => selKey(s) === key);
    if (idx >= 0) {
      MANUAL.selections.splice(idx, 1);
    } else {
      MANUAL.selections.push(hit);
    }
  } else {
    MANUAL.selections = [hit];
  }

  const cnt = MANUAL.selections.length;
  if (cnt === 0) {
    info.textContent = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
  } else if (cnt === 1) {
    const s = MANUAL.selections[0];
    if (s.type === 'point')  info.textContent = `選取：點 [${s.label}] #${s.idx}  (N${s.y.toFixed(3)}, E${s.x.toFixed(3)})`;
    else if (s.type === 'edge')   info.textContent = `選取：邊線 [${s.label}] 第${s.i}–${s.j}段`;
    else                          info.textContent = `選取：宗地 [${s.label}]`;
  } else {
    const labels = [...new Set(MANUAL.selections.map(s => s.label))].join('、');
    info.textContent = `已複選 ${cnt} 個 ${MANUAL.selections[0].type}（${labels}）`;
  }
  render();
}

function selKey(s) {
  if (s.type === 'point')  return `pt:${s.label}:${s.idx}`;
  if (s.type === 'edge')   return `edge:${s.label}:${s.i}:${s.j}`;
  return `parcel:${s.label}`;
}

function snapshotCoords() {
  const snap = {};
  for (const [k, v] of Object.entries(MANUAL.coords)) snap[k] = v.map(c => [c[0], c[1]]);
  return snap;
}

function pushHistory() {
  MANUAL.history.push(snapshotCoords());
  if (MANUAL.history.length > 80) MANUAL.history.shift();
}

function undoManual() {
  if (!MANUAL.history.length) { showToast('已無上一步可回復', false); return; }
  const snap = MANUAL.history.pop();
  for (const [k, v] of Object.entries(snap)) MANUAL.coords[k] = v;
  updateManualAreas();
  render();
  showToast(`已回到上一步（還可再退 ${MANUAL.history.length} 步）`);
}

function resetToOriginalCoords() {
  if (!ADJ.data) return;
  MANUAL.coords = {};
  for (const p of ADJ.data.parcels) {
    if (p.coords) MANUAL.coords[p.label] = p.coords.map(c => [c[0], c[1]]);
  }
  MANUAL.history    = [];
  MANUAL.selections = [];
  updateManualAreas();
  MANUAL.baseline = {};
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    MANUAL.baseline[label] = coords.map(c => [c[0], c[1]]);
  }
  render();
  showToast('已回復至自動調整前原始狀態');
  document.getElementById('manual-sel-info').textContent = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
}

const EPS_SHARE = 0.001;

function movePtInAll(origY, origX, dy, dx) {
  for (const coords of Object.values(MANUAL.coords)) {
    for (let k = 0; k < coords.length; k++) {
      if (Math.abs(coords[k][0] - origY) < EPS_SHARE && Math.abs(coords[k][1] - origX) < EPS_SHARE) {
        coords[k] = [coords[k][0] + dy, coords[k][1] + dx];
      }
    }
  }
}

function moveManualSelection(dy, dx) {
  if (!MANUAL.selections.length) return;

  pushHistory();

  const toMoveMap = new Map();

  for (const sel of MANUAL.selections) {
    if (sel.type === 'point') {
      const coords = MANUAL.coords[sel.label];
      if (!coords) continue;
      const [oy, ox] = coords[sel.idx];
      const key = `${oy.toFixed(6)}:${ox.toFixed(6)}`;
      toMoveMap.set(key, [oy, ox]);

    } else if (sel.type === 'edge') {
      const coords = MANUAL.coords[sel.label];
      if (!coords) continue;
      for (const idx of [sel.i, sel.j]) {
        const [oy, ox] = coords[idx];
        const key = `${oy.toFixed(6)}:${ox.toFixed(6)}`;
        toMoveMap.set(key, [oy, ox]);
      }

    } else if (sel.type === 'parcel') {
      const coords = MANUAL.coords[sel.label];
      if (!coords) continue;
      for (const [oy, ox] of coords) {
        const key = `${oy.toFixed(6)}:${ox.toFixed(6)}`;
        toMoveMap.set(key, [oy, ox]);
      }
    }
  }

  for (const [origY, origX] of toMoveMap.values()) {
    movePtInAll(origY, origX, dy, dx);
  }

  MANUAL.selections = MANUAL.selections.map(sel => {
    if (sel.type === 'point') return { ...sel, y: sel.y + dy, x: sel.x + dx };
    return sel;
  });

  updateManualAreas();
  render();
}

// ── 渲染（手動模式） ─────────────────────────────────────────────────────────
function _coordsChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i][0] - b[i][0]) > 1e-6 || Math.abs(a[i][1] - b[i][1]) > 1e-6) return true;
  }
  return false;
}

function renderAdjManual(W, H) {
  if (!MANUAL.active || !ADJ.data) return;

  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    const ma = MANUAL.areas[label];
    const col = ma ? (ma.ok ? 'rgba(62,207,110,.35)' : 'rgba(240,82,82,.35)') : 'rgba(100,100,120,.3)';
    drawPolygon(coords, col, 1);
  }

  // 進入手動模式（或按重設）當下的基準狀態：橘色虛線，只在已移動過的宗地顯示，供對照本次手動調整改了哪裡
  ctx.setLineDash([5, 4]);
  for (const [label, baseCoords] of Object.entries(MANUAL.baseline)) {
    const liveCoords = MANUAL.coords[label];
    if (!_coordsChanged(baseCoords, liveCoords)) continue;
    drawPolygon(baseCoords, 'rgba(245,158,11,.85)', 1.5, false);
  }
  ctx.setLineDash([]);

  // 標籤/較差文字只畫「本次自動調整過的宗地」+「拓樸上真正共用界址點的鄰地」+目前選取/滑鼠懸停的宗地，
  // 其餘宗地只有前面畫的淡色輪廓（無文字）——資料密集區域縮放進去常有幾十甚至上百筆宗地同時入鏡，
  // 全部都顯示文字會擠成一團完全看不清楚，也會讓人誤以為那些宗地「跑掉了」
  const interactedLabels = new Set(MANUAL.selections.map(s => s.label));
  if (MANUAL.hover) interactedLabels.add(MANUAL.hover.label);

  ctx.textAlign = 'center';
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    if (!MANUAL.relevantLabels.has(label) && !interactedLabels.has(label)) continue;
    const ma = MANUAL.areas[label];
    if (!ma || !coords.length) continue;
    const cy_ = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cx_ = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const [sx, sy] = worldToScreen(cy_, cx_);
    const col  = ma.ok ? '#3ecf6e' : '#f05252';

    const labelFs = scaledFontSize(0.8, sx, sy, 6, 26);
    ctx.font = `${labelFs}px Consolas`;
    const tw0 = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,12,18,.7)'; ctx.fillRect(sx - tw0 / 2 - 3, sy - labelFs * 0.7, tw0 + 6, labelFs + 4);
    ctx.fillStyle = col; ctx.fillText(label, sx, sy);

    const diffTxt = `差${ma.diff.toFixed(2)}`;
    const diffFs = scaledFontSize(0.7, sx, sy, 5, 22);
    ctx.font = `${diffFs}px Consolas`;
    const tw1 = ctx.measureText(diffTxt).width;
    const diffY = sy + labelFs * 0.6 + diffFs;
    ctx.fillStyle = 'rgba(10,12,18,.7)'; ctx.fillRect(sx - tw1 / 2 - 2, diffY - diffFs, tw1 + 4, diffFs + 4);
    ctx.fillStyle = col; ctx.fillText(diffTxt, sx, diffY);
  }

  function highlightEdge(label, i, j, strokeCol, lineW) {
    const coords = MANUAL.coords[label];
    if (!coords) return;
    const [sx1, sy1] = worldToScreen(coords[i][0], coords[i][1]);
    const [sx2, sy2] = worldToScreen(coords[j][0], coords[j][1]);
    ctx.strokeStyle = strokeCol; ctx.lineWidth = lineW || 3;
    ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke();
  }

  function highlightPt(label, idx, strokeCol, r) {
    const coords = MANUAL.coords[label];
    if (!coords || idx >= coords.length) return;
    const [sx, sy] = worldToScreen(coords[idx][0], coords[idx][1]);
    ctx.strokeStyle = strokeCol; ctx.lineWidth = 2;
    ctx.fillStyle = strokeCol.replace(/[\d.]+\)$/, '0.35)');
    ctx.beginPath(); ctx.arc(sx, sy, r || 7, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }

  const hover = MANUAL.hover;
  if (hover) {
    if (hover.type === 'point') highlightPt(hover.label, hover.idx, 'rgba(167,139,250,.8)', 6);
    else if (hover.type === 'edge') highlightEdge(hover.label, hover.i, hover.j, 'rgba(167,139,250,.7)', 2);
  }

  for (const sel of MANUAL.selections) {
    if (sel.type === 'point') {
      highlightPt(sel.label, sel.idx, '#a78bfa', 7);
      if (MANUAL.selections.length === 1) {
        const coords = MANUAL.coords[sel.label];
        if (coords && sel.idx < coords.length) {
          const [sx, sy] = worldToScreen(coords[sel.idx][0], coords[sel.idx][1]);
          ctx.fillStyle = '#a78bfa'; ctx.font = '10px Consolas'; ctx.textAlign = 'left';
          ctx.fillText(`N${coords[sel.idx][0].toFixed(3)}`, sx + 10, sy - 4);
          ctx.fillText(`E${coords[sel.idx][1].toFixed(3)}`, sx + 10, sy + 8);
        }
      }
    } else if (sel.type === 'edge') {
      highlightEdge(sel.label, sel.i, sel.j, '#a78bfa', 3);
    } else if (sel.type === 'parcel') {
      const coords = MANUAL.coords[sel.label];
      if (coords) {
        ctx.setLineDash([6, 4]);
        drawPolygon(coords, '#a78bfa', 2.5, false);
        ctx.setLineDash([]);
      }
    }
  }

  ctx.fillStyle = 'rgba(200,200,255,.6)';
  for (const coords of Object.values(MANUAL.coords)) {
    for (const [wy, wx] of coords) {
      const [sx, sy] = worldToScreen(wy, wx);
      ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function _on(id, fn) { const b = document.getElementById(id); if (b) b.onclick = fn; }

_on('btn-manual-adj',     () => { if (ADJ.result) enterManualMode(); });
_on('btn-manual-undo',    () => undoManual());
_on('btn-manual-origin',  () => resetToOriginalCoords());
_on('btn-manual-reset',   () => {
  initManualCoords();
  MANUAL.selections = [];
  MANUAL.history    = [];
  const si = document.getElementById('manual-sel-info');
  if (si) si.textContent = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
  render();
  showToast('已重設為自動調整結果');
});
_on('btn-manual-confirm', () => exitManualMode(true));
_on('btn-manual-exit',    () => exitManualMode(false));

(function () {
  const sel = document.getElementById('manual-step');
  if (sel) sel.onchange = () => { MANUAL.step = parseFloat(sel.value); };
})();

document.addEventListener('keydown', e => {
  if (!MANUAL.active) return;

  if (e.key === 'Escape') { exitManualMode(false); return; }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undoManual();
    return;
  }

  const step = MANUAL.step;
  let dy = 0, dx = 0;
  if (e.key === 'ArrowUp')    dy = +step;
  else if (e.key === 'ArrowDown')  dy = -step;
  else if (e.key === 'ArrowLeft')  dx = -step;
  else if (e.key === 'ArrowRight') dx = +step;
  else return;

  e.preventDefault();
  moveManualSelection(dy, dx);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PDF REPORT MODULE
// ═══════════════════════════════════════════════════════════════════════════════
function generateParcelPDF(p) {
  if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
    showToast('jsPDF 尚未載入，請稍後再試', true);
    return;
  }
  const A4W = 794, A4H = 1123;
  const offscreen = document.createElement('canvas');
  offscreen.width  = A4W;
  offscreen.height = A4H;
  const oc = offscreen.getContext('2d');

  drawPDFPage(oc, A4W, A4H, p);

  const img  = offscreen.toDataURL('image/jpeg', 0.92);
  const jsPDF = window.jspdf?.jsPDF || jspdf.jsPDF;
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const ptW  = doc.internal.pageSize.getWidth();
  const ptH  = doc.internal.pageSize.getHeight();
  doc.addImage(img, 'JPEG', 0, 0, ptW, ptH);
  doc.save(`adj_report_${p.label}.pdf`);
  showToast(`已下載：adj_report_${p.label}.pdf`);
}

function drawPDFPage(oc, W, H, p) {
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, W, H);

  const MARGIN = 40;
  let y = MARGIN;

  oc.fillStyle = '#1a1d27';
  oc.fillRect(0, 0, W, 70);
  oc.fillStyle = '#ffffff';
  oc.font = 'bold 22px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  oc.textAlign = 'left';
  oc.fillText('地籍調整報告', MARGIN, 44);
  oc.font = '13px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  oc.fillStyle = '#9ca3af';
  oc.fillText(`地號：${p.label}`, MARGIN + 200, 44);
  y = 90;

  const rows = [
    ['登記面積', `${p.reg.toFixed(4)} m²`],
    ['調整前面積', `${p.area_before.toFixed(4)} m²`],
    ['調整後面積', `${p.area_after.toFixed(4)} m²`],
    ['面積較差（前）', `${p.diff_before.toFixed(4)} m²`],
    ['面積較差（後）', `${p.diff_after.toFixed(4)} m²`],
    ['公差', `±${p.tol.toFixed(4)} m²`],
    ['自動調整位移', `${p.max_shift_cm.toFixed(2)} cm`],
    ['調整模式', p.mode],
  ];
  if (p.manually_edited) {
    rows.push(['手動調整', `是（額外位移 ${(p.manual_max_shift_cm || 0).toFixed(2)} cm）`]);
  }
  rows.push(['調整結果', p.status === 'ok' ? '✓ 進入公差範圍' : '⚠ 仍超出公差']);
  const COL1 = MARGIN, COL2 = MARGIN + 200;
  const ROW_H = 26;
  oc.font = 'bold 12px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  for (let i = 0; i < rows.length; i++) {
    const ry = y + i * ROW_H;
    oc.fillStyle = i % 2 === 0 ? '#f8f9fa' : '#ffffff';
    oc.fillRect(MARGIN - 4, ry - 14, W - MARGIN * 2 + 8, ROW_H);
    oc.fillStyle = '#374151';
    oc.font = '12px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
    oc.textAlign = 'left';
    oc.fillText(rows[i][0], COL1, ry);
    oc.fillStyle = rows[i][0] === '調整結果'
      ? (p.status === 'ok' ? '#15803d' : '#b91c1c')
      : '#111827';
    oc.font = 'bold 12px "Consolas", monospace';
    oc.fillText(rows[i][1], COL2, ry);
  }
  y += rows.length * ROW_H + 20;

  oc.strokeStyle = '#e5e7eb'; oc.lineWidth = 1;
  oc.beginPath(); oc.moveTo(MARGIN, y); oc.lineTo(W - MARGIN, y); oc.stroke();
  y += 16;

  oc.fillStyle = '#374151';
  oc.font = 'bold 13px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  oc.textAlign = 'left';
  oc.fillText('調整示意圖', MARGIN, y + 14);
  y += 30;

  const diagH = Math.min(H - y - 80, 480);
  const diagW = W - MARGIN * 2;
  oc.strokeStyle = '#e5e7eb'; oc.lineWidth = 1;
  oc.strokeRect(MARGIN, y, diagW, diagH);
  drawParcelDiagramInPDF(oc, MARGIN + 10, y + 10, diagW - 20, diagH - 20, p);
  y += diagH + 16;

  const legendItems = [
    { col: '#f05252', dash: true,  label: '原始輪廓' },
  ];
  if (p.manually_edited) {
    legendItems.push({ col: '#f59e0b', dash: true, label: '自動後／手動前' });
    legendItems.push({ col: '#38bdf8', dash: false, label: '手動調整位移' });
  }
  legendItems.push({ col: '#3ecf6e', dash: false, label: '最終調整後輪廓' });
  legendItems.push({ col: '#f5c542', dash: false, label: '最大位移點' });

  const PER_ROW = 3, COL_W = 155, ROW_H2 = 22;
  oc.font = '11px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  legendItems.forEach((item, i) => {
    const lx = MARGIN + (i % PER_ROW) * COL_W;
    const ly = y + 10 + Math.floor(i / PER_ROW) * ROW_H2;
    oc.strokeStyle = item.col; oc.lineWidth = 2;
    if (item.dash) oc.setLineDash([6, 4]); else oc.setLineDash([]);
    oc.beginPath(); oc.moveTo(lx, ly); oc.lineTo(lx + 26, ly); oc.stroke();
    oc.setLineDash([]);
    oc.fillStyle = '#374151'; oc.textAlign = 'left';
    oc.fillText(item.label, lx + 32, ly + 4);
  });
  y += 20 + Math.ceil(legendItems.length / PER_ROW) * ROW_H2;

  oc.fillStyle = '#9ca3af';
  oc.font = '10px "Consolas", monospace';
  oc.textAlign = 'center';
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  oc.fillText(`CadastralWorkbench v${window.CW_VERSION || '0.9'}  ·  ${dateStr}`, W / 2, H - 20);
}

function drawParcelDiagramInPDF(oc, ox, oy, W, H, p) {
  const before = p.coords_before;
  const after  = p.coords_after;         // 最終結果（含手動調整）
  const hasManual = !!(p.manually_edited && p.coords_after_auto);
  const auto = hasManual ? p.coords_after_auto : null;   // 純自動調整結果（手動調整前）
  if (!before || !after || !before.length || !after.length) return;

  const allY = [...before.map(c => c[0]), ...after.map(c => c[0]), ...(auto ? auto.map(c => c[0]) : [])];
  const allX = [...before.map(c => c[1]), ...after.map(c => c[1]), ...(auto ? auto.map(c => c[1]) : [])];
  const minY = Math.min(...allY), maxY = Math.max(...allY);
  const minX = Math.min(...allX), maxX = Math.max(...allX);
  const rY = maxY - minY || 1, rX = maxX - minX || 1;
  const pad = 20;
  const sc  = Math.min((W - pad * 2) / rX, (H - pad * 2) / rY);
  const offX = ox + pad + (W - pad * 2 - rX * sc) / 2;
  const offY = oy + pad + (H - pad * 2 - rY * sc) / 2;

  function toCanvas(wy, wx) {
    return [offX + (wx - minX) * sc, offY + (maxY - wy) * sc];
  }

  function strokePolygon(coords, color, lineWidth, dash) {
    oc.strokeStyle = color; oc.lineWidth = lineWidth;
    oc.setLineDash(dash || []);
    oc.beginPath();
    coords.forEach((c, i) => {
      const [cx_, cy_] = toCanvas(c[0], c[1]);
      if (i === 0) oc.moveTo(cx_, cy_); else oc.lineTo(cx_, cy_);
    });
    oc.closePath(); oc.stroke(); oc.setLineDash([]);
  }

  function drawArrows(fromCoords, toCoords, color) {
    const n = Math.min(fromCoords.length, toCoords.length);
    for (let i = 0; i < n; i++) {
      const [bx_, by_] = toCanvas(fromCoords[i][0], fromCoords[i][1]);
      const [ax_, ay_] = toCanvas(toCoords[i][0],   toCoords[i][1]);
      const dist = Math.hypot(ax_ - bx_, ay_ - by_);
      if (dist <= 0.5) continue;
      oc.strokeStyle = color; oc.lineWidth = 1;
      oc.beginPath(); oc.moveTo(bx_, by_); oc.lineTo(ax_, ay_); oc.stroke();
      const angle = Math.atan2(ay_ - by_, ax_ - bx_);
      const AL = 6;
      oc.beginPath();
      oc.moveTo(ax_, ay_);
      oc.lineTo(ax_ - AL * Math.cos(angle - 0.4), ay_ - AL * Math.sin(angle - 0.4));
      oc.lineTo(ax_ - AL * Math.cos(angle + 0.4), ay_ - AL * Math.sin(angle + 0.4));
      oc.closePath(); oc.fillStyle = color; oc.fill();
    }
  }

  // 原始輪廓
  strokePolygon(before, '#f05252', 1.5, [8, 5]);
  // 自動調整後（手動調整前）：只有手動調整過的宗地才畫，作為中間對照
  if (hasManual) strokePolygon(auto, '#f59e0b', 1.3, [3, 3]);

  // 最終調整後輪廓（實心填色）
  oc.strokeStyle = '#3ecf6e'; oc.lineWidth = 2; oc.setLineDash([]);
  oc.fillStyle = 'rgba(62,207,110,0.08)';
  oc.beginPath();
  after.forEach((c, i) => {
    const [cx_, cy_] = toCanvas(c[0], c[1]);
    if (i === 0) oc.moveTo(cx_, cy_); else oc.lineTo(cx_, cy_);
  });
  oc.closePath(); oc.fill(); oc.stroke();

  // 位移向量：有手動調整時拆成「自動調整」「手動調整」兩段箭頭；否則單一段
  if (hasManual) {
    drawArrows(before, auto, 'rgba(167,139,250,0.7)');
    drawArrows(auto, after, 'rgba(56,189,248,0.85)');
  } else {
    drawArrows(before, after, 'rgba(167,139,250,0.7)');
  }

  // 最大位移點：以「原始 → 最終」的實際距離為準（無論位移是自動或手動造成）
  let maxShift = 0, maxPt = null;
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const worldDist = Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]);
    if (worldDist > maxShift) { maxShift = worldDist; maxPt = i; }
  }

  if (maxPt !== null) {
    const [ax_, ay_] = toCanvas(after[maxPt][0], after[maxPt][1]);
    oc.fillStyle = '#f5c542';
    oc.beginPath(); oc.arc(ax_, ay_, 6, 0, Math.PI * 2); oc.fill();
    oc.strokeStyle = '#fff'; oc.lineWidth = 1.5;
    oc.beginPath(); oc.arc(ax_, ay_, 6, 0, Math.PI * 2); oc.stroke();
    oc.fillStyle = '#92400e';
    oc.font = 'bold 10px "Consolas", monospace';
    oc.textAlign = 'left';
    oc.fillText(`max: ${(maxShift * 100).toFixed(2)} cm`, ax_ + 10, ay_ + 4);
  }

  const scaleM  = 1;
  const scalePx = sc;
  if (scalePx > 10 && scalePx < 300) {
    const bx_ = ox + W - 10, by__ = oy + H - 10;
    oc.strokeStyle = '#6b7280'; oc.lineWidth = 1; oc.setLineDash([]);
    oc.beginPath(); oc.moveTo(bx_ - scalePx, by__); oc.lineTo(bx_, by__); oc.stroke();
    oc.beginPath(); oc.moveTo(bx_ - scalePx, by__ - 4); oc.lineTo(bx_ - scalePx, by__); oc.stroke();
    oc.beginPath(); oc.moveTo(bx_, by__ - 4); oc.lineTo(bx_, by__); oc.stroke();
    oc.fillStyle = '#6b7280'; oc.font = '9px Consolas'; oc.textAlign = 'center';
    oc.fillText(`${scaleM} m`, bx_ - scalePx / 2, by__ - 6);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
resizeCanvas();
render();
updateFitFileBadges();
updateAdjFileBadges();
updateStatusBar();
