/* ══════════════════════════════════════════════════════════════════════════
   CadastralWorkbench  app.js  v0.9
   純前端：Pyodide Worker + Canvas 渲染
   ══════════════════════════════════════════════════════════════════════════ */

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
  data:    null,   // parse 結果（parcels）
  result:  null,   // adjust 結果
  layers:  { before: true, after: true, labels: true, regArea: true, calcArea: true, adjDiff: true, adjTol: true },
  fileMap: {},     // {COA: File, BNP: File, PAR: File}
  coaText: null,   // 調整後 COA 文字（下載用）
};

const MANUAL = {
  active:     false,
  step:       0.01,        // metres per arrow-key press (default 1 cm)
  selections: [],          // [{ type:'point'|'edge'|'parcel', label, idx/i/j, y, x }, ...]
  hover:      null,
  coords:     {},          // label → [[y,x], ...]  working coordinates
  areas:      {},          // label → { area, reg, tol, diff, ok }
  history:    [],          // undo stack：每次移動前 push coords 快照（最多 80 步）
};

const BASEMAP = { visible: false, opacity: 70, provider: 'nlsc-photo' };

const TILE_PROVIDERS = {
  'nlsc-photo': (z,x,y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`,
  'nlsc-map':   (z,x,y) => `https://wmts.nlsc.gov.tw/wmts/EMAP5/default/GoogleMapsCompatible/${z}/${y}/${x}`,
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
  const txMin = Math.max(0, tileNE.x - 1);
  const txMax = Math.min(Math.pow(2, z) - 1, tileSW.x + 1);
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
        _tileCache.set(key, 'loading');
        const url = providerFn(z, tx, ty);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          _tileCache.set(key, img);
          render();
        };
        img.onerror = () => {
          _tileCache.set(key, 'error');
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
  } else {
    renderAdj(W, H);
  }

  updateStatusBar();
}

function updateStatusBar() {
  const zoomEl  = document.getElementById('status-zoom');
  const modEl   = document.getElementById('status-module');
  if (zoomEl) zoomEl.textContent = '×' + view.scale.toFixed(2);
  const modNames = { fit: '套圖', adj: '調整', crs: 'TWD97', basemap: '底圖' };
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
        ctx.font = `${Math.max(9, Math.min(11, view.scale * 0.8))}px Consolas`;
        const tw = ctx.measureText(p.label).width;
        ctx.fillStyle = 'rgba(10,12,18,.7)';
        ctx.fillRect(sx - tw / 2 - 3, sy - 10, tw + 6, 14);
        ctx.fillStyle = col;
        ctx.fillText(p.label, sx, sy);
        yOff = 16;
      }

      if (showExtra) {
        const ap = adjMap[p.label];
        const infoLines = [];
        if (ADJ.layers.regArea)  infoLines.push(`登記: ${p.reg.toFixed(2)} m²`);
        if (ADJ.layers.calcArea) infoLines.push(`計算: ${(ap ? ap.area_after : p.dig).toFixed(2)} m²`);
        if (ADJ.layers.adjDiff)  infoLines.push(`較差: ${(ap ? ap.diff_after : p.diff).toFixed(2)} m²`);
        if (ADJ.layers.adjTol)   infoLines.push(`公差: ±${p.tol.toFixed(2)} m²`);

        const infoFs = Math.max(8, Math.min(10, view.scale * 0.7));
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

// ── 分頁切換輔助 ─────────────────────────────────────────────────────────────
function switchTab(tabName) {
  activeTab = tabName;
  // Update toolbar tab buttons (only fit/adj are in toolbar now)
  document.querySelectorAll('.tb-btn[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`tab-${tabName}`);
  if (panel) panel.classList.add('active');
  updateBasemapCrsWarn();
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
  // Open basemap panel so user can tweak settings
  switchTab('basemap');
  render();
};

document.getElementById('btn-crs-quick').onclick = () => {
  document.getElementById('btn-crs-convert').click();
  // Open CRS panel to show progress / result
  switchTab('crs');
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
    case 'crs_result':
      onCrsResult(payload);
      break;
    case 'error':
      showToast('錯誤：' + payload, true);
      progressHide('fit-progress');
      progressHide('adj-progress');
      progressHide('crs-progress');
      setBtn('btn-fit',        false, '▶ 執行套疊');
      setBtn('btn-adj-run',    false, '▶ 執行調整');
      setBtn('btn-crs-convert', false, '🔄 一鍵轉 TWD97');
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
    return `<div style="border-bottom:1px solid #1e2030;padding:4px 0">
      <div style="display:flex;align-items:flex-start;gap:4px">
        <div style="flex:1;min-width:0;font-size:.88rem;line-height:1.8">
          <b>${p.label}</b> — 最大位移 ${p.max_shift_cm.toFixed(1)} cm (${p.mode})<br>
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
//  CRS MODULE (TWD67 → TWD97)
// ═══════════════════════════════════════════════════════════════════════════════
document.getElementById('btn-crs-convert').onclick = () => {
  if (!FIT.data) return;
  if (FIT.crsIsWGS97) { showToast('已是 TWD97 座標，無需重複轉換'); return; }

  // Collect all unique points from ref_pts + boundary_pts
  const ptMap = new Map();
  for (const p of FIT.data.ref_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    ptMap.set(key, [p.y, p.x]);
  }
  for (const p of FIT.data.boundary_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    ptMap.set(key, [p.y, p.x]);
  }
  // Also include segment endpoints
  for (const [y1, x1, y2, x2] of FIT.data.segments) {
    ptMap.set(`${y1.toFixed(6)}:${x1.toFixed(6)}`, [y1, x1]);
    ptMap.set(`${y2.toFixed(6)}:${x2.toFixed(6)}`, [y2, x2]);
  }

  const pts = [...ptMap.values()];

  setBtn('btn-crs-convert', true, '轉換中…');
  progressShow('crs-progress');
  worker.postMessage({ type: 'crs_convert', payload: { pts } });
};

function onCrsResult(result) {
  progressHide('crs-progress');
  setBtn('btn-crs-convert', false, '🔄 一鍵轉 TWD97');

  if (!FIT.data) return;

  // Build lookup: original [N,E] → converted [N97,E97]
  // We need to re-run conversion on each point individually using the same ordering
  // Instead, rebuild a map from input key → output
  // The worker returns pts in same order as payload.pts
  // We must re-collect in the same order to map back

  const ptMap = new Map();
  const orderedKeys = [];
  for (const p of FIT.data.ref_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    if (!ptMap.has(key)) { ptMap.set(key, null); orderedKeys.push(key); }
  }
  for (const p of FIT.data.boundary_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    if (!ptMap.has(key)) { ptMap.set(key, null); orderedKeys.push(key); }
  }
  for (const [y1, x1, y2, x2] of FIT.data.segments) {
    for (const [y, x] of [[y1,x1],[y2,x2]]) {
      const key = `${y.toFixed(6)}:${x.toFixed(6)}`;
      if (!ptMap.has(key)) { ptMap.set(key, null); orderedKeys.push(key); }
    }
  }

  // Map converted pts back
  result.pts.forEach(([N97, E97], i) => {
    ptMap.set(orderedKeys[i], [N97, E97]);
  });

  // Apply to ref_pts
  for (const p of FIT.data.ref_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    const conv = ptMap.get(key);
    if (conv) { p.y = conv[0]; p.x = conv[1]; }
  }
  // Apply to boundary_pts
  for (const p of FIT.data.boundary_pts) {
    const key = `${p.y.toFixed(6)}:${p.x.toFixed(6)}`;
    const conv = ptMap.get(key);
    if (conv) { p.y = conv[0]; p.x = conv[1]; }
  }
  // Apply to segments
  FIT.data.segments = FIT.data.segments.map(([y1, x1, y2, x2]) => {
    const k1 = `${y1.toFixed(6)}:${x1.toFixed(6)}`;
    const k2 = `${y2.toFixed(6)}:${x2.toFixed(6)}`;
    const c1 = ptMap.get(k1) || [y1, x1];
    const c2 = ptMap.get(k2) || [y2, x2];
    return [c1[0], c1[1], c2[0], c2[1]];
  });

  // Recalculate extents
  const allY = [], allX = [];
  for (const [y1, x1, y2, x2] of FIT.data.segments) { allY.push(y1, y2); allX.push(x1, x2); }
  for (const p of FIT.data.ref_pts)      { allY.push(p.y); allX.push(p.x); }
  for (const p of FIT.data.boundary_pts) { allY.push(p.y); allX.push(p.x); }
  const pad = (Math.max(...allY) - Math.min(...allY)) * 0.05;
  extents = {
    minY: Math.min(...allY) - pad, maxY: Math.max(...allY) + pad,
    minX: Math.min(...allX) - pad, maxX: Math.max(...allX) + pad,
  };

  FIT.crsIsWGS97 = true;
  FIT.result = null; // Clear fit result since coords changed

  // Show result section
  const resEl = document.getElementById('crs-result-section');
  document.getElementById('crs-dn').textContent    = (result.mean_dn >= 0 ? '+' : '') + result.mean_dn.toFixed(3) + ' m';
  document.getElementById('crs-de').textContent    = (result.mean_de >= 0 ? '+' : '') + result.mean_de.toFixed(3) + ' m';
  document.getElementById('crs-count').textContent = result.pts.length + ' 點';
  resEl.style.display = '';

  // Update from-badge
  const badge = document.getElementById('crs-from-badge');
  if (badge) { badge.textContent = 'TWD97'; badge.className = 'crs-badge twd97'; }

  // Disable & visually mark quick button as done
  const quickBtn = document.getElementById('btn-crs-quick');
  if (quickBtn) { quickBtn.disabled = true; quickBtn.title = '已是 TWD97 座標'; }

  updateBasemapCrsWarn();
  resizeCanvas(); initView(); render();
  showToast('TWD67→TWD97 轉換完成');
}

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

  const adjKeys = new Set(ADJ.result.adjusted_parcels.map(p => p.label));
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
          }
        }
      }
    }
  }

  updateManualAreas();
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

  const tb = document.getElementById('manual-toolbar');
  if (tb) tb.style.display = 'flex';
  const ht = document.getElementById('hint');
  if (ht) ht.style.display = 'none';
  const si = document.getElementById('manual-sel-info');
  if (si) si.textContent = '點擊選取界址點/邊線/宗地，Ctrl+點擊可複選同類';
  render();
}

function exitManualMode(apply) {
  if (apply && ADJ.result) {
    for (const ap of ADJ.result.adjusted_parcels) {
      if (MANUAL.coords[ap.label]) {
        ap.coords_after = MANUAL.coords[ap.label].map(c => [c[0], c[1]]);
        const ma = MANUAL.areas[ap.label];
        if (ma) {
          ap.area_after = ma.area;
          ap.diff_after = ma.diff;
          ap.status     = ma.ok ? 'ok' : 'still_over';
        }
      }
    }
    renderAdjResultList();
    showToast('手動調整已套用');
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
function renderAdjManual(W, H) {
  if (!MANUAL.active || !ADJ.data) return;

  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    const ma = MANUAL.areas[label];
    const col = ma ? (ma.ok ? 'rgba(62,207,110,.35)' : 'rgba(240,82,82,.35)') : 'rgba(100,100,120,.3)';
    drawPolygon(coords, col, 1);
  }

  ctx.textAlign = 'center';
  for (const [label, coords] of Object.entries(MANUAL.coords)) {
    const ma = MANUAL.areas[label];
    if (!ma || !coords.length) continue;
    const cy_ = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cx_ = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const [sx, sy] = worldToScreen(cy_, cx_);
    const col  = ma.ok ? '#3ecf6e' : '#f05252';

    ctx.font = `${Math.max(9, Math.min(11, view.scale * 0.8))}px Consolas`;
    const tw0 = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,12,18,.7)'; ctx.fillRect(sx - tw0 / 2 - 3, sy - 11, tw0 + 6, 14);
    ctx.fillStyle = col; ctx.fillText(label, sx, sy);

    const diffTxt = `差${ma.diff.toFixed(2)}`;
    ctx.font = `${Math.max(8, Math.min(10, view.scale * 0.7))}px Consolas`;
    const tw1 = ctx.measureText(diffTxt).width;
    ctx.fillStyle = 'rgba(10,12,18,.7)'; ctx.fillRect(sx - tw1 / 2 - 2, sy + 4, tw1 + 4, 13);
    ctx.fillStyle = col; ctx.fillText(diffTxt, sx, sy + 15);
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
    ['最大位移量', `${p.max_shift_cm.toFixed(2)} cm`],
    ['調整模式', p.mode],
    ['調整結果', p.status === 'ok' ? '✓ 進入公差範圍' : '⚠ 仍超出公差'],
  ];
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
    { col: '#f05252', dash: true,  label: '調整前輪廓' },
    { col: '#3ecf6e', dash: false, label: '調整後輪廓' },
    { col: '#f5c542', dash: false, label: '最大位移點' },
  ];
  let lx = MARGIN;
  oc.font = '11px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  for (const item of legendItems) {
    oc.strokeStyle = item.col; oc.lineWidth = 2;
    if (item.dash) oc.setLineDash([6, 4]); else oc.setLineDash([]);
    oc.beginPath(); oc.moveTo(lx, y + 10); oc.lineTo(lx + 28, y + 10); oc.stroke();
    oc.setLineDash([]);
    oc.fillStyle = '#374151'; oc.textAlign = 'left';
    oc.fillText(item.label, lx + 34, y + 14);
    lx += 120;
  }
  y += 30;

  oc.fillStyle = '#9ca3af';
  oc.font = '10px "Consolas", monospace';
  oc.textAlign = 'center';
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  oc.fillText(`CadastralWorkbench v${window.CW_VERSION || '0.9'}  ·  ${dateStr}`, W / 2, H - 20);
}

function drawParcelDiagramInPDF(oc, ox, oy, W, H, p) {
  const before = p.coords_before;
  const after  = p.coords_after;
  if (!before || !after || !before.length || !after.length) return;

  const allY = [...before.map(c => c[0]), ...after.map(c => c[0])];
  const allX = [...before.map(c => c[1]), ...after.map(c => c[1])];
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

  oc.strokeStyle = '#f05252'; oc.lineWidth = 1.5; oc.setLineDash([8, 5]);
  oc.beginPath();
  before.forEach((c, i) => {
    const [cx_, cy_] = toCanvas(c[0], c[1]);
    if (i === 0) oc.moveTo(cx_, cy_); else oc.lineTo(cx_, cy_);
  });
  oc.closePath(); oc.stroke(); oc.setLineDash([]);

  oc.strokeStyle = '#3ecf6e'; oc.lineWidth = 2; oc.setLineDash([]);
  oc.fillStyle = 'rgba(62,207,110,0.08)';
  oc.beginPath();
  after.forEach((c, i) => {
    const [cx_, cy_] = toCanvas(c[0], c[1]);
    if (i === 0) oc.moveTo(cx_, cy_); else oc.lineTo(cx_, cy_);
  });
  oc.closePath(); oc.fill(); oc.stroke();

  let maxShift = 0, maxPt = null;
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const [bx_, by_] = toCanvas(before[i][0], before[i][1]);
    const [ax_, ay_] = toCanvas(after[i][0],  after[i][1]);
    const dist = Math.hypot(ax_ - bx_, ay_ - by_);
    if (dist > 0.5) {
      oc.strokeStyle = 'rgba(167,139,250,0.7)'; oc.lineWidth = 1;
      oc.beginPath(); oc.moveTo(bx_, by_); oc.lineTo(ax_, ay_); oc.stroke();
      const angle = Math.atan2(ay_ - by_, ax_ - bx_);
      const AL = 6;
      oc.beginPath();
      oc.moveTo(ax_, ay_);
      oc.lineTo(ax_ - AL * Math.cos(angle - 0.4), ay_ - AL * Math.sin(angle - 0.4));
      oc.lineTo(ax_ - AL * Math.cos(angle + 0.4), ay_ - AL * Math.sin(angle + 0.4));
      oc.closePath(); oc.fillStyle = 'rgba(167,139,250,0.9)'; oc.fill();
    }
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
    oc.fillText(`max: ${p.max_shift_cm.toFixed(2)} cm`, ax_ + 10, ay_ + 4);
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
