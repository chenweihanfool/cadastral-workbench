"""
adjust_cadastral.py  —  Pyodide 瀏覽器版  v2
==============================================
由 pyodide_worker.js 呼叫。每次呼叫前 worker 設定以下全域變數：

parse 模式 (adj_mode == 'parse'):
  coa_buf, bnp_buf, par_buf : Uint8Array (Big5 文字檔)
  → 解析所有宗地，判斷是否超過公差，輸出 result_json

adjust 模式 (adj_mode == 'adjust'):
  target_keys_json : JSON 字串 [[main,sub], ...]  (空陣列 = 調整全部超差)
  → 執行調整，輸出 result_json
"""

import json
import math
import re
from collections import defaultdict

# ── 公差公式 ────────────────────────────────────────────────────────────────
def _tolerance(F):
    return (0.25 + 0.07 * (F ** 0.25)) * math.sqrt(F)

# ── 解析 COA ────────────────────────────────────────────────────────────────
def _parse_coa(text):
    lines = text.splitlines()
    header = lines[0] if lines else ''
    parts = header.split()
    scale = 500
    if len(parts) >= 3:
        try: scale = int(parts[2])
        except ValueError: pass
    points = {}
    for line in lines[1:]:
        raw = line.rstrip('\n')
        if len(raw) < 6: continue
        try: pid = int(raw[:5])
        except ValueError: continue
        rest = raw[6:]
        if len(rest) < 31: continue
        try:
            Y = float(rest[:16])
            X = float(rest[16:31])
        except ValueError: continue
        flag = rest[31] if len(rest) > 31 else ' '
        points[pid] = {'Y': Y, 'X': X, 'flag': flag}
    return header, points, lines, scale

# ── 解析 BNP ────────────────────────────────────────────────────────────────
def _parse_bnp(text):
    lines = text.splitlines()
    parcel_points = defaultdict(list)
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 5: continue
        try:
            main = int(parts[0])
            sub  = int(parts[1])
            pts  = [int(p) for p in parts[4:]]
        except ValueError: continue
        parcel_points[(main, sub)].extend(pts)
    return parcel_points

# ── 解析 PAR ────────────────────────────────────────────────────────────────
def _parse_par(text):
    lines = text.splitlines()
    parcel_info = {}
    pat = re.compile(
        r'^\s*(\d+)\s+(\d+)\s+\d+\s+([\d.]+)\s+\d+\s+\d+\s+([\d.]+)(\S)'
    )
    for idx, line in enumerate(lines[1:], 1):
        m = pat.match(line.rstrip('\n'))
        if m:
            main   = int(m.group(1))
            sub    = int(m.group(2))
            reg    = float(m.group(3))
            dig    = float(m.group(4))
            status = m.group(5)
            parcel_info[(main, sub)] = {
                'reg': reg, 'dig': dig, 'status': status, 'line_idx': idx
            }
    return parcel_info

# ── 面積（Shoelace）────────────────────────────────────────────────────────
def _signed_area(coords):
    n = len(coords)
    a = 0.0
    for i in range(n):
        j = (i+1) % n
        a += coords[i][0]*coords[j][1] - coords[j][0]*coords[i][1]
    return a / 2.0

def _area(coords):
    return abs(_signed_area(coords))

def _centroid(coords):
    return sum(c[0] for c in coords)/len(coords), sum(c[1] for c in coords)/len(coords)

# ── 調整（directed / scale fallback）──────────────────────────────────────
def _adjust(coords, point_ids, target_area, pt_index, key, max_shift=0.30):
    """
    max_shift: 每個界址點最大允許位移量（公尺），預設 0.30 m。
    directed 模式：限制二分搜索範圍在 ±max_shift 內。
    uniform_scale 模式：限制縮放比例使最大位移 ≤ max_shift。
    """
    target_set = {key}
    movable = []
    for pid in point_ids:
        others = pt_index.get(pid, set()) - target_set
        movable.append(not others or all(m >= 9000 for (m,_) in others))

    sign_A = _signed_area(coords)
    orient = -1 if sign_A < 0 else 1
    n = len(coords)

    if any(movable):
        shift_vecs = []
        for i in range(n):
            if not movable[i]:
                shift_vecs.append((0.0, 0.0))
                continue
            normals = []
            for ea, eb in [((i-1)%n, i), (i, (i+1)%n)]:
                ya, xa = coords[ea]; yb, xb = coords[eb]
                dy, dx = yb-ya, xb-xa
                length = math.sqrt(dy*dy + dx*dx)
                if length > 1e-10:
                    normals.append((orient*dx/length, orient*(-dy)/length))
            if normals:
                ny = sum(v[0] for v in normals)/len(normals)
                nx = sum(v[1] for v in normals)/len(normals)
                norm = math.sqrt(ny*ny+nx*nx)
                if norm > 1e-10: ny, nx = ny/norm, nx/norm
                shift_vecs.append((ny, nx))
            else:
                shift_vecs.append((0.0, 0.0))

        cur = _area(coords)
        # 以 max_shift 限制二分搜索上界
        lo, hi = (0.0, max_shift) if cur < target_area else (-max_shift, 0.0)
        for _ in range(60):
            mid = (lo+hi)/2
            a = _area([(y+mid*sv[0], x+mid*sv[1]) for (y,x),sv in zip(coords,shift_vecs)])
            if (cur < target_area and a < target_area) or (cur > target_area and a > target_area):
                lo = mid
            else:
                hi = mid
        d = (lo+hi)/2
        new_c = [(y+d*sv[0], x+d*sv[1]) for (y,x),sv in zip(coords,shift_vecs)]
        return new_c, abs(d)*100, 'directed_9xxx'
    else:
        cur = _area(coords)
        if cur == 0: return coords, 0.0, 'uniform_scale'
        k = math.sqrt(target_area/cur)
        cy_, cx_ = _centroid(coords)
        # 限制縮放比例：最大位移 ≤ max_shift
        if max_shift > 0:
            dists = [math.sqrt((y-cy_)**2+(x-cx_)**2) for y,x in coords]
            max_d_c = max(dists) if dists else 0.0
            if max_d_c > 0:
                if k > 1.0:
                    k = min(k, 1.0 + max_shift / max_d_c)
                else:
                    k = max(k, 1.0 - max_shift / max_d_c)
        new_c = [(cy_+k*(y-cy_), cx_+k*(x-cx_)) for y,x in coords]
        max_d = max(math.sqrt((ny-y)**2+(nx-x)**2) for (y,x),(ny,nx) in zip(coords,new_c)) if new_c else 0.0
        return new_c, max_d*100, 'uniform_scale'

# ── 讀取 bytes ──────────────────────────────────────────────────────────────
def _decode(buf):
    raw = bytes(buf.to_py())
    try: return raw.decode('big5')
    except Exception: return raw.decode('utf-8', errors='replace')

# ════════════════════════════════════════════════════════════════════════════
#  PARSE MODE
# ════════════════════════════════════════════════════════════════════════════
if adj_mode == 'parse':  # noqa: F821
    coa_header, coa_points, coa_lines, coa_scale = _parse_coa(_decode(coa_buf))  # noqa: F821
    parcel_points = _parse_bnp(_decode(bnp_buf))  # noqa: F821
    parcel_info   = _parse_par(_decode(par_buf))   # noqa: F821
    pt_index      = defaultdict(set)
    for key_, pids in parcel_points.items():
        for pid in pids:
            pt_index[pid].add(key_)

    parcels_out = []
    for key_, pids in parcel_points.items():
        main_, sub_ = key_
        par_rec = parcel_info.get(key_)
        coords_ = [(coa_points[pid]['Y'], coa_points[pid]['X'])
                   for pid in pids if pid in coa_points]
        if len(coords_) < 3: continue
        area_ = _area(coords_)
        reg_   = par_rec['reg'] if par_rec else area_
        diff_  = reg_ - area_
        tol_   = _tolerance(reg_) if reg_ > 0 else 0.0
        exceeds_ = abs(diff_) > tol_ if tol_ > 0 else False
        parcels_out.append({
            'main': int(main_), 'sub': int(sub_),
            'label': f'{main_}-{sub_}',
            'coords': [[float(y), float(x)] for y,x in coords_],
            'reg': float(reg_), 'dig': float(area_),
            'diff': float(diff_), 'tol': float(tol_),
            'exceeds': exceeds_,
            'status': 'exceeds' if exceeds_ else 'ok',
        })

    result_json = json.dumps({'mode': 'parse', 'parcels': parcels_out, 'scale': coa_scale})  # noqa: F841

# ════════════════════════════════════════════════════════════════════════════
#  ADJUST MODE  (coa_points / parcel_points / parcel_info / pt_index 已在全域)
# ════════════════════════════════════════════════════════════════════════════
elif adj_mode == 'adjust':  # noqa: F821
    target_keys = [tuple(k) for k in json.loads(target_keys_json)]  # noqa: F821
    # 讀取最大調整幅度（公尺），未傳入時預設 0.30 m
    try:
        _max_shift_m = float(json.loads(max_shift_json))  # noqa: F821
    except Exception:
        _max_shift_m = 0.30

    if not target_keys:
        # adjust all that exceed tolerance
        target_keys = [
            k for k, rec in parcel_info.items()
            if abs(rec['reg'] - _area([(coa_points[pid]['Y'], coa_points[pid]['X'])
                                       for pid in parcel_points.get(k, [])
                                       if pid in coa_points])) > _tolerance(rec['reg'])
        ]

    TARGET_FRACTION = 0.9
    adjusted_parcels = []
    new_coa_points = dict(coa_points)  # mutate copy

    for key_ in target_keys:
        main_, sub_ = key_
        pids = parcel_points.get(key_, [])
        par_rec = parcel_info.get(key_)
        coords_b = [(coa_points[pid]['Y'], coa_points[pid]['X'])
                    for pid in pids if pid in coa_points]
        if len(coords_b) < 3 or not par_rec: continue
        reg_   = par_rec['reg']
        area_b = _area(coords_b)
        diff_b = reg_ - area_b
        tol_   = _tolerance(reg_)
        if abs(diff_b) <= tol_: continue
        target_area_ = reg_ - math.copysign(tol_ * TARGET_FRACTION, diff_b)
        new_c, max_cm, mode_ = _adjust(coords_b, pids, target_area_, pt_index, key_, max_shift=_max_shift_m)
        area_a = _area(new_c)
        diff_a = reg_ - area_a
        for pid, (ny, nx) in zip(pids, new_c):
            if pid in new_coa_points:
                new_coa_points[pid] = dict(new_coa_points[pid])
                new_coa_points[pid]['Y'] = ny
                new_coa_points[pid]['X'] = nx
        adjusted_parcels.append({
            'main': int(main_), 'sub': int(sub_),
            'label': f'{main_}-{sub_}',
            'coords_before': [[float(y), float(x)] for y,x in coords_b],
            'coords_after':  [[float(y), float(x)] for y,x in new_c],
            'reg': float(reg_), 'area_before': float(area_b), 'area_after': float(area_a),
            'diff_before': float(diff_b), 'diff_after': float(diff_a),
            'tol': float(tol_), 'max_shift_cm': float(max_cm), 'mode': mode_,
            'status': 'ok' if abs(diff_a) <= tol_ else 'still_over',
        })

    # Generate updated COA text
    new_coa_lines = list(coa_lines)
    for i, line in enumerate(new_coa_lines[1:], 1):
        raw_ = line.rstrip('\n')
        if len(raw_) < 5: continue
        try: pid_ = int(raw_[:5])
        except ValueError: continue
        if pid_ in new_coa_points and pid_ in {
            pid for key_ in target_keys for pid in parcel_points.get(key_, [])
        }:
            p_ = new_coa_points[pid_]
            new_coa_lines[i] = f'{pid_:5d} {p_["Y"]:16.8f}{p_["X"]:15.8f}{p_["flag"]}\n'
    coa_text_out = ''.join(new_coa_lines)

    result_json = json.dumps({  # noqa: F841
        'mode': 'adjust',
        'adjusted_parcels': adjusted_parcels,
        'coa_text': coa_text_out,
    })
