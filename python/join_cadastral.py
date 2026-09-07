"""
join_cadastral.py  —  Pyodide 瀏覽器版  v1
===========================================
地籍圖分幅接圖模組。由 pyodide_worker.js 呼叫。

檔案格式（KC 文字檔，非 D14/D2C/D2D/D2B 的 DBF 格式）：
  .COA  座標檔：點號 → (Y, X) 絕對座標（該分幅內部索引，非跨分幅唯一）
  .BNP  界址點拓樸：(段, 小段)（分幅內部編號，非跨分幅唯一）→ COA 點號序列
  .PAR  地號基本資料：(段, 小段) → 登記面積 / 圖解面積

重要：COA 的點號、BNP 的 (段,小段) 鍵都只在「同一分幅檔案內」唯一，
跨分幅會有編號碰撞（同一組 (段,小段) 在不同分幅各自代表不同地號）。
因此合併時一律以 (分幅代號, 段, 小段) 作為地號的全域唯一鍵，
不嘗試把不同分幅裡數字相同的鍵視為同一宗地拼接。

parse 模式 (join_mode == 'parse')：
  globals 由 worker 動態設定：sheet_ids_json（分幅代號陣列的 JSON），
  以及每個分幅 i 對應的 sheet_{i}_coa / sheet_{i}_bnp / sheet_{i}_par
  （Uint8Array，Big5 編碼文字檔）。
  → 解析全部分幅、合併地號多邊形、偵測跨分幅共邊點座標微差，輸出 result_json
"""

import json
import math
import re
from collections import defaultdict

SEAM_RADIUS_M = 0.5   # 搜尋跨分幅「同一界址點」候選的最大距離（公尺）


# ── 讀取 bytes ────────────────────────────────────────────────────────────
def _decode(buf):
    if isinstance(buf, (bytes, bytearray)):
        raw = bytes(buf)
    else:
        raw = bytes(buf.to_py())
    try:
        return raw.decode('big5')
    except Exception:
        return raw.decode('utf-8', errors='replace')


def _lines(text):
    return text.split('\r\n') if '\r\n' in text else text.splitlines()


# ── 解析 COA：點號 → (Y, X) ─────────────────────────────────────────────────
def _parse_coa(text):
    pts = {}
    for l in _lines(text)[1:]:
        if len(l) < 37:
            continue
        idx_s = l[0:5].strip()
        if not idx_s:
            continue
        try:
            pid = int(idx_s)
            y = float(l[6:22])
            x = float(l[22:37])
        except ValueError:
            continue
        pts[pid] = (y, x)
    return pts


# ── 解析 BNP：(段,小段) → COA 點號序列 ──────────────────────────────────────
# 部分點號後方會有 +/- 標記字元（推測為弧形界址線方向），整行以正規式逐一
# 擷取數字＋可選符號，不能用固定欄寬或 split() —— 欄位長度不足時數值會
# 直接頂到下一欄，中間沒有空白。
_TOKEN_RE = re.compile(r'(\d+)([+\-]?)')


def _parse_bnp(text):
    parcels = {}
    for l in _lines(text)[1:]:
        if not l.strip():
            continue
        toks = _TOKEN_RE.findall(l)
        if len(toks) < 4:
            continue
        try:
            sec, sub, seq, total = (int(t[0]) for t in toks[:4])
        except ValueError:
            continue
        idxs = [int(t[0]) for t in toks[4:]]
        d = parcels.setdefault((sec, sub), {})
        d[seq] = idxs
    polys = {}
    for key, parts in parcels.items():
        idxs = []
        for s in sorted(parts):
            idxs.extend(parts[s])
        polys[key] = idxs
    return polys


# ── 解析 PAR：(段,小段) → 登記面積 / 圖解面積（固定欄寬）────────────────────
def _parse_par(text):
    recs = {}
    for l in _lines(text)[1:]:
        if len(l) < 40:
            continue
        try:
            sec = int(l[0:4])
            sub = int(l[4:8])
            area_reg = float(l[12:22])
            area_calc = float(l[30:40])
        except ValueError:
            continue
        recs[(sec, sub)] = {'area_reg': area_reg, 'area_calc': area_calc}
    return recs


def _shoelace_area(ring):
    n = len(ring)
    s = 0.0
    for i in range(n):
        y1, x1 = ring[i]
        y2, x2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def _centroid(ring):
    n = len(ring)
    return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n


# ═══════════════════════════════════════════════════════════════════════════
#  PARSE MODE
# ═══════════════════════════════════════════════════════════════════════════
if join_mode == 'parse':  # noqa: F821
    sheet_ids = json.loads(sheet_ids_json)  # noqa: F821
    _g = globals()

    sheets = []          # [{id, coa, bnp, par}, ...]
    sheet_warnings = []
    for i, sid in enumerate(sheet_ids):
        coa_raw = _g.get(f'sheet_{i}_coa')
        bnp_raw = _g.get(f'sheet_{i}_bnp')
        par_raw = _g.get(f'sheet_{i}_par')
        if coa_raw is None or bnp_raw is None:
            sheet_warnings.append(f'{sid}：缺少 COA 或 BNP，已略過')
            continue
        coa = _parse_coa(_decode(coa_raw))
        bnp = _parse_bnp(_decode(bnp_raw))
        par = _parse_par(_decode(par_raw)) if par_raw is not None else {}
        sheets.append({'id': sid, 'coa': coa, 'bnp': bnp, 'par': par})

    parcels_out = []
    sheets_meta = []
    all_pts = []   # (y, x) — 供跨分幅共邊點比對
    pt_meta = []   # (sheet_idx, point_id)

    for si, sheet in enumerate(sheets):
        coa, bnp, par = sheet['coa'], sheet['bnp'], sheet['par']
        ys, xs = [], []
        n_parcels_ok = 0
        for (sec, sub), idxs in bnp.items():
            ring = [coa[i] for i in idxs if i in coa]
            if len(ring) < 3:
                continue
            area_calc_geom = _shoelace_area(ring)
            cyy, cxx = _centroid(ring)
            par_rec = par.get((sec, sub))
            parcels_out.append({
                'sheet': sheet['id'],
                'sec': sec, 'sub': sub,
                'label': f'{sec}-{sub}' if sub else str(sec),
                'coords': [[float(y), float(x)] for y, x in ring],
                'area_reg': float(par_rec['area_reg']) if par_rec else None,
                'area_calc': float(par_rec['area_calc']) if par_rec else float(area_calc_geom),
                'area_geom': float(area_calc_geom),
                'centroid': [float(cyy), float(cxx)],
            })
            n_parcels_ok += 1
            ys.extend(p[0] for p in ring)
            xs.extend(p[1] for p in ring)
        for pid, (y, x) in coa.items():
            all_pts.append((y, x))
            pt_meta.append((si, pid))
        sheets_meta.append({
            'id': sheet['id'],
            'n_points': len(coa),
            'n_parcels': n_parcels_ok,
            'bbox': [min(ys), min(xs), max(ys), max(xs)] if ys else None,
        })

    # ── 跨分幅共邊點座標微差偵測（cKDTree 最近鄰搜尋）────────────────────────
    seam_pairs = []
    seam_bins = {'exact': 0, 'le_5cm': 0, 'le_10cm': 0, 'le_30cm': 0, 'le_50cm': 0}
    if len(all_pts) >= 2:
        try:
            import numpy as np
            from scipy.spatial import cKDTree
            arr = np.array(all_pts)
            tree = cKDTree(arr)
            pairs = tree.query_pairs(r=SEAM_RADIUS_M)
            for i, j in pairs:
                si_, pi_ = pt_meta[i]
                sj_, pj_ = pt_meta[j]
                if si_ == sj_:
                    continue
                d = math.hypot(arr[i][0] - arr[j][0], arr[i][1] - arr[j][1])
                if d <= 1e-6:
                    seam_bins['exact'] += 1
                elif d <= 0.05:
                    seam_bins['le_5cm'] += 1
                elif d <= 0.10:
                    seam_bins['le_10cm'] += 1
                elif d <= 0.30:
                    seam_bins['le_30cm'] += 1
                else:
                    seam_bins['le_50cm'] += 1
                seam_pairs.append({
                    'sheet_a': sheets[si_]['id'], 'pt_a': pi_,
                    'y_a': float(arr[i][0]), 'x_a': float(arr[i][1]),
                    'sheet_b': sheets[sj_]['id'], 'pt_b': pj_,
                    'y_b': float(arr[j][0]), 'x_b': float(arr[j][1]),
                    'diff_m': float(d),
                })
        except Exception as e:
            sheet_warnings.append(f'共邊點比對失敗（已略過）：{e}')

    seam_pairs.sort(key=lambda r: -r['diff_m'])

    result_json = json.dumps({  # noqa: F841
        'mode': 'join',
        'sheets': sheets_meta,
        'parcels': parcels_out,
        'warnings': sheet_warnings,
        'seam_report': {
            'radius_m': SEAM_RADIUS_M,
            'n_matched_pairs': len(seam_pairs),
            'bins': seam_bins,
            'worst': seam_pairs[:50],
        },
        'stats': {
            'n_sheets': len(sheets),
            'n_parcels': len(parcels_out),
            'n_points': len(all_pts),
        },
    })
