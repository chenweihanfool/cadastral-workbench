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
  → 解析結果（sheets 清單）留在 Python 全域，供 export 模式沿用

export 模式 (join_mode == 'export')：
  沿用 parse 模式留下的全域 `sheets`（須先呼叫過一次 parse）。
  → 把所有分幅合併模擬成單一分幅的 COA/BNP/PAR 文字檔：
    - COA 點號全域重新編號（1..N，依分幅順序）
    - BNP/PAR 的 (段,小段) 盡量保留原值；因為這組鍵只在單一分幅內唯一，
      跨分幅撞號時把小段欄位加上 1000×分幅序號（使用者指定的錯開方式）
      以避免合併後同一把鍵對到兩筆不同地號，並在 renumbered 列出所有被
      調整過的地號供使用者核對
  → 輸出 result_json：coa_text / bnp_text / par_text / renumbered / stats
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
# 欄寬是用「精確定位每個數字在原始位元組中的起訖位置」驗證出來的固定
# 寬度：段(4)＋小段(4)＋序號(3)＋總點數(4)＝檔頭共 17 碼，界址點從
# 第 15 碼開始、每格固定 6 碼。(先前版本誤把總點數欄寬算成 6 碼——用
# Python 的 int() 轉換剛好會自動吃掉多餘空白，讓錯誤的切法在自己的
# 解析器上「看起來」也能正確讀出數字，但實際輸出的位元組位置跟原始
# 格式差了 2 碼，導致其他嚴格照欄位位置讀取的軟體整段界址線讀不到。
# 已用總點數 1/2/3 位數的多筆真實資料交叉比對，總點數欄位結尾都精準
# 落在第 15 個字元，不會因為位數不同而跑掉。)
# 極少數界址點號後面會多一個 +/- 標記字元（推測為弧形界址線方向）撐爆
# 欄位，這種情況下用該格開頭的數字部分，擷取不到就跳過。
_LEADING_INT_RE = re.compile(r'\s*(\d+)')
_HEADER_W = (4, 4, 3, 4)   # 段, 小段, 序號, 總點數
_VERTEX_W = 6


def _parse_bnp(text):
    h0, h1, h2, h3 = _HEADER_W
    header_w = h0 + h1 + h2 + h3
    parcels = {}
    for l in _lines(text)[1:]:
        if not l.strip():
            continue
        if len(l) < header_w:
            continue
        sec_s, sub_s, seq_s, total_s = l[0:h0], l[h0:h0 + h1], l[h0 + h1:h0 + h1 + h2], l[h0 + h1 + h2:header_w]
        try:
            sec, sub, seq = int(sec_s), int(sub_s), int(seq_s)
        except ValueError:
            continue
        m = _LEADING_INT_RE.match(total_s)
        if not m:
            continue
        total = int(m.group(1))
        rest = l[header_w:]
        idxs = []
        for i in range(0, len(rest), _VERTEX_W):
            slot = rest[i:i + _VERTEX_W]
            if not slot.strip():
                continue
            try:
                idxs.append(int(slot))
            except ValueError:
                mm = _LEADING_INT_RE.match(slot)
                if mm:
                    idxs.append(int(mm.group(1)))
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

# ═══════════════════════════════════════════════════════════════════════════
#  EXPORT MODE（sheets 沿用 parse 模式留下的全域）
# ═══════════════════════════════════════════════════════════════════════════
elif join_mode == 'export':  # noqa: F821
    if 'sheets' not in globals() or not sheets:  # noqa: F821
        result_json = json.dumps({'mode': 'export', 'error': '尚未解析任何分幅，請先執行接圖'})  # noqa: F841
    else:
        SUB_OFFSET = 1000  # 撞號時：新小段 = 原小段 + SUB_OFFSET × 分幅序號

        # ── COA：點號全域重新編號 ────────────────────────────────────────────
        new_pid = {}   # (sheet_idx, old_pid) -> new_pid
        coa_lines = []
        next_pid = 1
        for si, sheet in enumerate(sheets):  # noqa: F821
            for old_pid in sorted(sheet['coa'].keys()):
                y, x = sheet['coa'][old_pid]
                new_pid[(si, old_pid)] = next_pid
                coa_lines.append(f'{next_pid:5d} {y:16.8f}{x:15.8f} ')
                next_pid += 1
        n_points = next_pid - 1

        # ── BNP + PAR：(段,小段) 撞號錯開，重建拓樸與屬性 ───────────────────
        # 撞號時的新小段 = 原小段 + SUB_OFFSET × 第幾次撞號（1,2,3…），而非
        # ×分幅序號 —— 因為 PAR 是固定欄寬格式（段/小段各佔 4 碼，
        # 0-9999），offset 若直接乘上分幅序號，分幅數一多（例如第 11 個分
        # 幅、序號 10）就會讓小段變成 5 碼、撐爆固定欄位、把後面的面積等
        # 欄位全部擠位。改用「同一把鍵第幾次撞號」計數，同一把鍵實際撞號
        # 次數通常只有 2-4 次（本例最多 4 次），offset 遠小於欄寬上限，
        # 語意上一樣是「加上一個好辨識的大偏移量」，但保證不會爆欄。
        used_keys = set()
        key_seen = defaultdict(int)   # 原始 (段,小段) → 已出現次數
        renumbered = []
        bnp_lines = []
        par_lines = []
        n_parcels_out = 0
        CHUNK = 11  # 每行界址點數，比照原始檔案的視覺寬度

        for si, sheet in enumerate(sheets):  # noqa: F821
            for (sec, sub), idxs in sheet['bnp'].items():
                valid_idxs = [i for i in idxs if i in sheet['coa']]
                if len(valid_idxs) < 3:
                    continue

                occurrence = key_seen[(sec, sub)]
                key_seen[(sec, sub)] += 1
                new_sec, new_sub = sec, sub
                if occurrence > 0:
                    bump = occurrence
                    new_sub = sub + SUB_OFFSET * bump
                    while new_sub > 9999 or (new_sec, new_sub) in used_keys:
                        bump += 1
                        new_sub = sub + SUB_OFFSET * bump
                        if bump > 9000:   # 理論上不會發生的保底防呆
                            new_sub = sub
                            break
                    renumbered.append({
                        'sheet': sheet['id'], 'old_sec': sec, 'old_sub': sub,
                        'new_sec': new_sec, 'new_sub': new_sub,
                    })
                used_keys.add((new_sec, new_sub))

                new_idxs = [new_pid[(si, i)] for i in valid_idxs]
                total = len(new_idxs)
                for seq, start in enumerate(range(0, total, CHUNK), start=1):
                    chunk = new_idxs[start:start + CHUNK]
                    # 緊貼固定欄寬（段4＋小段4＋序號3＋總數4，界址點每格6碼），
                    # 中間不加任何分隔空白，且每行一律補空白到 CHUNK 個欄位的
                    # 滿寬（即使這行界址點不足 11 個）——這是用精確定位每個
                    # 數字的位元組起訖位置，從原始資料回推出的真正格式。地政
                    # 軟體是照這個固定位置切字串讀取，欄寬或行長差一點，後面
                    # 每個界址點的位置就會整個位移，被切出完全不同的點號，
                    # 輕則界址線連錯，重則整段被判斷成 0 筆、什麼線都讀不到。
                    vals = ''.join(f'{v:6d}' for v in chunk)
                    vals = vals.ljust(CHUNK * 6)
                    bnp_lines.append(f'{new_sec:4d}{new_sub:4d}{seq:3d}{total:4d}{vals}')

                ring = [sheet['coa'][i] for i in valid_idxs]
                area_geom = _shoelace_area(ring)
                cyy, cxx = _centroid(ring)
                par_rec = sheet['par'].get((sec, sub))
                area_reg  = par_rec['area_reg']  if par_rec else area_geom
                area_calc = par_rec['area_calc'] if par_rec else area_geom
                # PAR 沿用原始固定欄寬（段4碼＋小段4碼緊接、無分隔），因為
                # _parse_par 是用固定欄位切字串讀取；new_sub 已保證 ≤9999
                # 所以不會撐爆這個欄寬。
                par_lines.append(
                    f'{new_sec:4d}{new_sub:4d} 336{area_reg:10.2f}'
                    f'{new_sec:4d}{new_sub:4d}{area_calc:10.2f} '
                    f'{cyy:14.4f} {cxx:13.4f}  0'
                )
                n_parcels_out += 1

        # 檔頭一律緊貼（檔名6碼＋筆數5碼，中間不加分隔空白），比照原始檔案
        # 的排版——BNP 的檔頭筆數看起來會被地政軟體拿來當「接下來要讀幾
        # 行」的依據，欄位一旦位移，讀到的筆數就會跟本文兜不起來，實測
        # 曾經因此整段界址線被判斷成 0 筆、只剩 COA 的點位看得到。
        coa_text = '\r\n'.join([f'JOIN01{n_points:5d}  500  {n_points:5d}'] + coa_lines) + '\r\n'
        bnp_text = '\r\n'.join([f'JOIN01{len(bnp_lines):5d}'] + bnp_lines) + '\r\n'
        par_text = '\r\n'.join([f'JOIN01{n_parcels_out:5d}  0 0 09006'] + par_lines) + '\r\n'

        result_json = json.dumps({  # noqa: F841
            'mode': 'export',
            'coa_text': coa_text,
            'bnp_text': bnp_text,
            'par_text': par_text,
            'renumbered': renumbered,
            'stats': {
                'n_points': n_points,
                'n_parcels': n_parcels_out,
                'n_renumbered': len(renumbered),
            },
        })
