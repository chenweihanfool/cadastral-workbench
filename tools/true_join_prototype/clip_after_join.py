"""
接圖（splice）完成之後，再依 KC6336 的整體範圍篩選——整筆保留、不切割，
跟先前 clip_task/clip.py 的邏輯一致，只是這次篩的是「已經真正接圖過」的
最終地號，而不是接圖前的原始碎片。這樣可以避免在已經被攤平、失去分幅
資訊的檔案上重新做接圖判斷。
"""
import sys, pickle, re
sys.path.insert(0, '.')
from common import shoelace
from shapely.geometry import Polygon
from shapely.ops import unary_union

UP = '/root/.claude/uploads/d8feafc2-294d-5b2c-bdd5-88eccd17b573'


def _lines(text):
    return text.split('\r\n') if '\r\n' in text else text.splitlines()


def read_big5(path):
    with open(path, 'rb') as f:
        return f.read().decode('big5', errors='replace')


def parse_coa(text):
    pts = {}
    for l in _lines(text)[1:]:
        if len(l) < 37:
            continue
        idx_s = l[0:5].strip()
        if not idx_s:
            continue
        try:
            pid = int(idx_s)
            y = float(l[6:22]); x = float(l[22:37])
        except ValueError:
            continue
        pts[pid] = (y, x)
    return pts


_LEADING_INT_RE = re.compile(r'\s*(\d+)')


def parse_bnp(text):
    parcels = {}
    for l in _lines(text)[1:]:
        if not l.strip():
            continue
        if len(l) < 15:
            continue
        try:
            sec = int(l[0:4]); sub = int(l[4:8]); seq = int(l[8:11])
        except ValueError:
            continue
        m = _LEADING_INT_RE.match(l[11:15])
        if not m:
            continue
        total = int(m.group(1))
        rest = l[15:]
        idxs = []
        for i in range(0, len(rest), 6):
            slot = rest[i:i + 6]
            if not slot.strip():
                continue
            try:
                idxs.append(int(slot))
            except ValueError:
                mm = _LEADING_INT_RE.match(slot)
                if mm:
                    idxs.append(int(mm.group(1)))
        parcels.setdefault((sec, sub), {})[seq] = idxs
    polys = {}
    for key, parts in parcels.items():
        idxs = []
        for s in sorted(parts):
            idxs.extend(parts[s])
        polys[key] = idxs
    return polys


def to_shapely(ring):
    coords = [(x, y) for y, x in ring]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    try:
        poly = Polygon(coords)
        if not poly.is_valid:
            poly = poly.buffer(0)
        return poly
    except Exception:
        return None


print('讀取 KC6336（參考範圍）...')
kc6336_coa = parse_coa(read_big5(f'{UP}/97c739fc-KC6336.COA'))
kc6336_bnp = parse_bnp(read_big5(f'{UP}/b171a345-KC6336.BNP'))
kc6336_polys = []
for key, idxs in kc6336_bnp.items():
    ring = [kc6336_coa[i] for i in idxs if i in kc6336_coa]
    if len(ring) < 3:
        continue
    poly = to_shapely(ring)
    if poly is not None and not poly.is_empty and poly.area > 0:
        kc6336_polys.append(poly)
print(f'  KC6336: {len(kc6336_coa)} 點, {len(kc6336_polys)} 個有效多邊形')
ref_boundary = unary_union(kc6336_polys)
print(f'  聯集範圍 bounds={ref_boundary.bounds}')

print('載入已接圖的 KC0336（本次 true-join 結果）...')
with open('sheets.pkl', 'rb') as f:
    sheets = pickle.load(f)
with open('merged_parcels.pkl', 'rb') as f:
    d = pickle.load(f)
merged_parcels = d['merged_parcels']
coordlookup = d['coordlookup']
print(f'  接圖後總地號數: {len(merged_parcels)}')

kept = {}
for mkey, info in merged_parcels.items():
    ring = [coordlookup[p] for p in info['ring']]
    if len(ring) < 3:
        continue
    poly = to_shapely(ring)
    if poly is None or poly.is_empty:
        continue
    if poly.intersects(ref_boundary):
        kept[mkey] = info
print(f'篩選結果: 保留 {len(kept)} / {len(merged_parcels)} 筆地號（與 KC6336 範圍相交，整筆保留不切割）')

with open('clipped_merged_parcels.pkl', 'wb') as f:
    pickle.dump({'merged_parcels': kept, 'coordlookup': coordlookup}, f)
print('saved clipped_merged_parcels.pkl')
