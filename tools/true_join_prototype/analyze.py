import sys, pickle
sys.path.insert(0, '.')
from common import shoelace

with open('sheets.pkl', 'rb') as f:
    sheets = pickle.load(f)

ADJ_TOL = 5.0
MIN_OVERLAP = 100.0

def find_adjacency(sheets, tol=ADJ_TOL, min_overlap=MIN_OVERLAP):
    pairs = []
    ids = list(sheets)
    for i in range(len(ids)):
        for j in range(len(ids)):
            if i == j: continue
            a, b = ids[i], ids[j]
            ay0, ax0, ay1, ax1 = sheets[a]['bbox']
            by0, bx0, by1, bx1 = sheets[b]['bbox']
            if abs(ay0 - by1) < tol:
                overlap = min(ax1, bx1) - max(ax0, bx0)
                if overlap > min_overlap:
                    seam_y = (ay0 + by1) / 2
                    pairs.append({'type': 'h', 'top': a, 'bottom': b, 'seam': seam_y, 'overlap': overlap})
            if abs(ax1 - bx0) < tol:
                overlap = min(ay1, by1) - max(ay0, by0)
                if overlap > min_overlap:
                    seam_x = (ax1 + bx0) / 2
                    pairs.append({'type': 'v', 'west': a, 'east': b, 'seam': seam_x, 'overlap': overlap})
    return pairs

adjacency = find_adjacency(sheets)
adj_set = set()
for p in adjacency:
    a = p.get('top', p.get('west'))
    b = p.get('bottom', p.get('east'))
    adj_set.add(frozenset((a, b)))

# key -> list of sheet ids that have this key
key_sheets = {}
for sid, sh in sheets.items():
    for key in sh['bnp']:
        key_sheets.setdefault(key, []).append(sid)

multi = {k: v for k, v in key_sheets.items() if len(v) > 1}
print(f'共 {len(key_sheets)} 個 (段,小段) key，其中 {len(multi)} 個出現在多個分幅')

from collections import Counter
cnt = Counter(len(v) for v in multi.values())
print('分佈（出現分幅數 -> key數）:', dict(cnt))

# check how many multi-sheet keys have all-pairs adjacency (fully connected via adjacency edges)
non_adjacent_examples = []
for k, sids in multi.items():
    if len(sids) == 2:
        if frozenset(sids) not in adj_set:
            non_adjacent_examples.append((k, sids))
    else:
        # check connectivity via adjacency graph restricted to these sids
        pass

print(f'\n2分幅共用但彼此不相鄰(對角)的 key 數: {len(non_adjacent_examples)}')
for k, sids in non_adjacent_examples[:10]:
    print(' ', k, sids)

# For >2 sheet keys, check adjacency connectivity
multi3 = {k: v for k, v in multi.items() if len(v) > 2}
print(f'\n出現在 >2 個分幅的 key 數: {len(multi3)}')
for k, sids in list(multi3.items())[:20]:
    edges = [ (a,b) for i,a in enumerate(sids) for b in sids[i+1:] if frozenset((a,b)) in adj_set ]
    print(' ', k, sids, 'adjacent-edges-among-them:', edges)
