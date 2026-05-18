"""
fit_cadastral.py  —  Pyodide 瀏覽器版  v2
===========================================
由 pyodide_worker.js 呼叫。每次呼叫前 worker 設定以下全域變數：

parse 模式 (fit_mode == 'parse'):
  d14_buf, d2c_buf, d2d_buf, d2b_buf : Uint8Array (DBF 二進位)
  → 解析後將 segs / ref_pts / boundary_pts / cy / cx 存為 Python 全域
  → 輸出 result_json

fit 模式 (fit_mode == 'fit'):
  weights_json : JSON 字串 {"0": 1.0, "2": 0.0, ...}  (idx→weight)
  → 使用既存 Python 全域跑最佳化
  → 輸出 result_json
"""

import json
import math
import struct
from scipy.optimize import minimize

# ── DBF 讀取（純 Python，接受 bytearray）─────────────────────────────────────
def _read_dbf(raw):
    data = bytearray(raw)
    num_records = struct.unpack_from('<I', data, 4)[0]
    header_size = struct.unpack_from('<H', data, 8)[0]
    record_size = struct.unpack_from('<H', data, 10)[0]
    fields = []
    off = 32
    while off < header_size - 1:
        if data[off] == 0x0D:
            break
        name = bytes(data[off:off+11]).split(b'\x00')[0].decode('ascii', 'replace')
        ftype = chr(data[off+11])
        flen  = data[off+16]
        fdec  = data[off+17]
        fields.append((name, ftype, flen, fdec))
        off += 32
    records = []
    ro = header_size
    for _ in range(num_records):
        if ro + record_size > len(data):
            break
        rec = data[ro:ro+record_size]
        pos = 1
        row = {}
        for name, ftype, flen, fdec in fields:
            raw_f = bytes(rec[pos:pos+flen])
            if ftype == 'N':
                s = raw_f.decode('ascii', 'replace').strip()
                try:
                    v = float(s) if s else 0.0
                except Exception:
                    v = 0.0
            elif ftype == 'C':
                v = raw_f.decode('big5', 'replace').strip()
            else:
                v = raw_f
            row[name] = v
            pos += flen
        records.append(row)
        ro += record_size
    return records

# ── 幾何工具 ────────────────────────────────────────────────────────────────
def _transform(y, x, theta, ty, tx, cy, cx):
    dy = y - cy; dx = x - cx
    c, s = math.cos(theta), math.sin(theta)
    return cy + c*dy - s*dx + ty, cx + s*dy + c*dx + tx

def _pt_seg_dist_sq(qy, qx, p1y, p1x, p2y, p2x):
    dy = p2y - p1y; dx = p2x - p1x
    len_sq = dy*dy + dx*dx
    if len_sq < 1e-12:
        return (qy-p1y)**2 + (qx-p1x)**2
    cross = (qy-p1y)*dx - (qx-p1x)*dy
    return cross*cross / len_sq

def _foot(qy, qx, p1y, p1x, p2y, p2x):
    dy = p2y - p1y; dx = p2x - p1x
    len_sq = dy*dy + dx*dx
    if len_sq < 1e-12:
        return p1y, p1x
    t = ((qy-p1y)*dy + (qx-p1x)*dx) / len_sq
    return p1y + t*dy, p1x + t*dx

def _nearest_seg(qy, qx, segs_):
    best_d, best_i = float('inf'), 0
    for i, (p1y, p1x, p2y, p2x) in enumerate(segs_):
        d = _pt_seg_dist_sq(qy, qx, p1y, p1x, p2y, p2x)
        if d < best_d:
            best_d = d; best_i = i
    return best_i

# ═══════════════════════════════════════════════════════════════════════════════
#  PARSE MODE
# ═══════════════════════════════════════════════════════════════════════════════
if fit_mode == 'parse':  # noqa: F821
    d14_recs = _read_dbf(bytes(d14_buf.to_py()))  # noqa: F821
    d2c_recs = _read_dbf(bytes(d2c_buf.to_py()))  # noqa: F821
    d2d_recs = _read_dbf(bytes(d2d_buf.to_py()))  # noqa: F821

    # 分離界址點與參考點
    boundary_pts = {}
    ref_pts = []
    for r in d14_recs:
        try:
            num = int(float(r.get('COT_NUMBER', 0)))
            ref = int(float(r.get('COT_REF', 0)))
            y   = float(r.get('COT_Y', 0))
            x   = float(r.get('COT_X', 0))
        except Exception:
            continue
        if ref == 0:
            boundary_pts[num] = (y, x)
        else:
            ref_pts.append((num + ref/100.0, y, x))

    # 建立界址線段 (D2D × D2C)
    segs = []
    for r in d2d_recs:
        try:
            t = int(float(r.get('LIN_TOP', 0)))
            b = int(float(r.get('LIN_BOT', 0)))
        except Exception:
            continue
        if t == b or t < 1 or b < 1:
            continue
        if t > len(d2c_recs) or b > len(d2c_recs):
            continue
        p1 = d2c_recs[t-1]; p2 = d2c_recs[b-1]
        try:
            y1 = float(p1['COT_Y']); x1 = float(p1['COT_X'])
            y2 = float(p2['COT_Y']); x2 = float(p2['COT_X'])
        except Exception:
            continue
        if y1 == y2 and x1 == x2:
            continue
        segs.append((y1, x1, y2, x2))

    # 旋轉中心
    all_y = [float(r['COT_Y']) for r in d2c_recs if r.get('COT_Y')]
    all_x = [float(r['COT_X']) for r in d2c_recs if r.get('COT_X')]
    cy = sum(all_y) / len(all_y)
    cx = sum(all_x) / len(all_x)

    # 初始垂距（套疊前）
    init_assoc = [_nearest_seg(qy, qx, segs) for (_, qy, qx) in ref_pts]
    d0_list = [
        math.sqrt(max(0.0, _pt_seg_dist_sq(qy, qx, *segs[init_assoc[k]])))
        for k, (_, qy, qx) in enumerate(ref_pts)
    ]

    # 輸出供 JS 顯示
    bpts_list = [{'y': float(v[0]), 'x': float(v[1])} for v in boundary_pts.values()]
    rpts_list = [{'num': float(n), 'y': float(y), 'x': float(x)} for n, y, x in ref_pts]
    segs_list = [[float(a) for a in s] for s in segs]

    result_json = json.dumps({  # noqa: F841
        'mode': 'parse',
        'segments':     segs_list,
        'ref_pts':      rpts_list,
        'boundary_pts': bpts_list,
        'cy': float(cy),
        'cx': float(cx),
        'stats': {
            'n_segs': len(segs),
            'n_ref':  len(ref_pts),
        },
        'd0_list': [float(d) for d in d0_list],
    })

# ═══════════════════════════════════════════════════════════════════════════════
#  FIT MODE  (segs / ref_pts / boundary_pts / cy / cx 已在 Python globals)
# ═══════════════════════════════════════════════════════════════════════════════
elif fit_mode == 'fit':  # noqa: F821
    _weights = json.loads(weights_json)  # noqa: F821  {"0":1.0, "2":0.0, ...}
    _w = [float(_weights.get(str(k), 1.0)) for k in range(len(ref_pts))]

    associations = [_nearest_seg(qy, qx, segs) for (_, qy, qx) in ref_pts]

    def _cost(params):
        theta, ty_, tx_ = params
        total = 0.0
        for k, (_, qy, qx) in enumerate(ref_pts):
            if _w[k] <= 0:
                continue
            p1y, p1x, p2y, p2x = segs[associations[k]]
            np1y, np1x = _transform(p1y, p1x, theta, ty_, tx_, cy, cx)
            np2y, np2x = _transform(p2y, p2x, theta, ty_, tx_, cy, cx)
            total += _w[k] * _pt_seg_dist_sq(qy, qx, np1y, np1x, np2y, np2x)
        return total

    opts = {'ftol': 1e-15, 'gtol': 1e-10, 'maxiter': 10000}
    res = minimize(_cost, [0.0, 0.0, 0.0], method='L-BFGS-B', options=opts)
    theta_opt, ty_opt, tx_opt = res.x

    # 更新關聯，再最佳化一輪
    segs_t = [
        (*_transform(p1y, p1x, theta_opt, ty_opt, tx_opt, cy, cx),
         *_transform(p2y, p2x, theta_opt, ty_opt, tx_opt, cy, cx))
        for (p1y, p1x, p2y, p2x) in segs
    ]
    new_assoc = [_nearest_seg(qy, qx, segs_t) for (_, qy, qx) in ref_pts]
    if any(a != b for a, b in zip(associations, new_assoc)):
        associations = new_assoc
        minimize(_cost, [theta_opt, ty_opt, tx_opt], method='L-BFGS-B', options=opts)
        res2 = minimize(_cost, [theta_opt, ty_opt, tx_opt], method='L-BFGS-B', options=opts)
        theta_opt, ty_opt, tx_opt = res2.x

    # 套疊後線段
    fitted_segs = [
        [*_transform(p1y, p1x, theta_opt, ty_opt, tx_opt, cy, cx),
         *_transform(p2y, p2x, theta_opt, ty_opt, tx_opt, cy, cx)]
        for (p1y, p1x, p2y, p2x) in segs
    ]

    # 逐點明細
    details = []
    d_after_list = []
    for k, (num, qy, qx) in enumerate(ref_pts):
        p1y, p1x, p2y, p2x = segs[associations[k]]
        np1y, np1x = _transform(p1y, p1x, theta_opt, ty_opt, tx_opt, cy, cx)
        np2y, np2x = _transform(p2y, p2x, theta_opt, ty_opt, tx_opt, cy, cx)
        d_aft = math.sqrt(max(0.0, _pt_seg_dist_sq(qy, qx, np1y, np1x, np2y, np2x)))
        fy, fx = _foot(qy, qx, np1y, np1x, np2y, np2x)
        d_after_list.append(d_aft)
        details.append({
            'num':    float(num),
            'y':      float(qy),
            'x':      float(qx),
            'd_before': float(d0_list[k]),
            'd_after':  float(d_aft),
            'foot_y':   float(fy),
            'foot_x':   float(fx),
            'weight':   float(_w[k]),
        })

    n_used = sum(1 for w in _w if w > 0)
    rmse_after  = math.sqrt(sum(d**2 for d, w in zip(d_after_list, _w) if w > 0) / max(1, n_used))
    rmse_before = math.sqrt(sum(d**2 for d in d0_list) / max(1, len(d0_list)))
    max_after   = max(d_after_list) if d_after_list else 0
    max_before  = max(d0_list)      if d0_list      else 0

    # 套疊後界址點（D2C 轉換）
    fitted_boundary = [
        {'y': float(_transform(v[0], v[1], theta_opt, ty_opt, tx_opt, cy, cx)[0]),
         'x': float(_transform(v[0], v[1], theta_opt, ty_opt, tx_opt, cy, cx)[1])}
        for v in boundary_pts.values()
    ]

    result_json = json.dumps({  # noqa: F841
        'mode': 'fit',
        'fitted_segments':  fitted_segs,
        'fitted_boundary':  fitted_boundary,
        'theta_deg': float(math.degrees(theta_opt)),
        'ty': float(ty_opt),
        'tx': float(tx_opt),
        'cy': float(cy),
        'cx': float(cx),
        'stats': {
            'n_segs':      len(segs),
            'n_ref':       len(ref_pts),
            'n_used':      n_used,
            'rmse_before': float(rmse_before),
            'rmse_after':  float(rmse_after),
            'max_before':  float(max_before),
            'max_after':   float(max_after),
        },
        'details': details,
    })
