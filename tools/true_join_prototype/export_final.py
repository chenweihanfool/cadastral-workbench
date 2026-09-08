import sys, pickle
from collections import defaultdict
sys.path.insert(0, '.')
from common import shoelace

with open('sheets.pkl', 'rb') as f:
    sheets = pickle.load(f)
with open('merged_parcels.pkl', 'rb') as f:
    d = pickle.load(f)

merged_parcels = d['merged_parcels']
coordlookup = d['coordlookup']

CHUNK = 11
SUB_OFFSET = 1000


def centroid(ring):
    n = len(ring)
    return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n


# ── COA：全域重新編號，涵蓋所有分幅的所有點（與既有 v1 匯出邏輯一致）───────
sheet_ids = list(sheets)
new_pid = {}
coa_lines = []
next_pid = 1
for sid in sheet_ids:
    for old_pid in sorted(sheets[sid]['coa'].keys()):
        y, x = sheets[sid]['coa'][old_pid]
        new_pid[(sid, old_pid)] = next_pid
        coa_lines.append(f'{next_pid:5d} {y:16.8f}{x:15.8f} ')
        next_pid += 1
n_points = next_pid - 1

# ── BNP + PAR：撞號時 sub += 1000 × 第幾次撞號 ─────────────────────────────
key_seen = defaultdict(int)
used_keys = set()
renumbered = []
bnp_lines = []
par_lines = []
n_parcels_out = 0
n_dropped_short = 0

for mkey, info in merged_parcels.items():
    real_key = mkey[0] if isinstance(mkey[0], tuple) else mkey
    sec, sub = real_key
    ring_keys = info['ring']
    if len(ring_keys) < 3:
        n_dropped_short += 1
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
            if bump > 9000:
                new_sub = sub
                break
        renumbered.append({
            'sheets': sorted(info['sheets']), 'old_sec': sec, 'old_sub': sub,
            'new_sec': new_sec, 'new_sub': new_sub,
        })
    used_keys.add((new_sec, new_sub))

    new_idxs = [new_pid[p] for p in ring_keys]
    total = len(new_idxs)
    for seq, start in enumerate(range(0, total, CHUNK), start=1):
        chunk = new_idxs[start:start + CHUNK]
        vals = ''.join(f'{v:6d}' for v in chunk)
        vals = vals.ljust(CHUNK * 6)
        bnp_lines.append(f'{new_sec:4d}{new_sub:4d}{seq:3d}{total:4d}{vals}')

    ring_coords = [coordlookup[p] for p in ring_keys]
    area_geom = shoelace(ring_coords)
    cyy, cxx = centroid(ring_coords)

    # area_reg（登記面積）取任一有記錄的來源分幅的值（跨分幅片段記錄的
    # 應該相同）；area_calc（圖解面積）一律用「接圖後最終多邊形」重新
    # 算出來的實際面積，而不是沿用接圖前單一片段的舊值——接圖前的片段
    # 面積已經不對應接圖後的真正形狀了。
    area_reg = None
    for sid in info['sheets']:
        rec = sheets[sid]['par'].get(real_key)
        if rec:
            area_reg = rec['area_reg']
            break
    if area_reg is None:
        area_reg = area_geom
    area_calc = area_geom

    par_lines.append(
        f'{new_sec:4d}{new_sub:4d} 336{area_reg:10.2f}'
        f'{new_sec:4d}{new_sub:4d}{area_calc:10.2f} '
        f'{cyy:14.4f} {cxx:13.4f}  0'
    )
    n_parcels_out += 1

coa_text = '\r\n'.join([f'JOIN01{n_points:5d}  500  {n_points:5d}'] + coa_lines) + '\r\n'
bnp_text = '\r\n'.join([f'JOIN01{len(bnp_lines):5d}'] + bnp_lines) + '\r\n'
par_text = '\r\n'.join([f'JOIN01{n_parcels_out:5d}  0 0 09006'] + par_lines) + '\r\n'

with open('KC0336.COA', 'w', encoding='big5', newline='') as f:
    f.write(coa_text)
with open('KC0336.BNP', 'w', encoding='big5', newline='') as f:
    f.write(bnp_text)
with open('KC0336.PAR', 'w', encoding='big5', newline='') as f:
    f.write(par_text)

n_spliced = sum(1 for v in merged_parcels.values() if v.get('spliced'))
print(f'輸出完成：COA {n_points} 點、BNP/PAR {n_parcels_out} 筆地號（其中真正接圖成功 {n_spliced} 筆、'
      f'跳過過短 {n_dropped_short} 筆、撞號調整 {len(renumbered)} 筆）')
