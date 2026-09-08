import sys, pickle, json
sys.path.insert(0, '.')
from common import shoelace, parse_par

with open('sheets.pkl', 'rb') as f:
    sheets = pickle.load(f)

ADJ_TOL = 5.0
MIN_OVERLAP = 100.0
SEAM_TOL = 1.5


def find_adjacency(sheets, tol=ADJ_TOL, min_overlap=MIN_OVERLAP):
    pairs = []
    ids = list(sheets)
    for i in range(len(ids)):
        for j in range(len(ids)):
            if i == j:
                continue
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

coordlookup = {}
for sid, sh in sheets.items():
    for idx, coord in sh['coa'].items():
        coordlookup[(sid, idx)] = coord


def on_seam(coord, seam_type, seam_val, tol=SEAM_TOL):
    y, x = coord
    v = y if seam_type == 'h' else x
    return abs(v - seam_val) < tol


def cut_ring_at_seam(ring, seam_type, seam_val, tol=SEAM_TOL):
    """ring: list of composite (sid, idx) keys (cyclic). Returns (chain, before, after) or None
    if no single contiguous seam-hugging run is found."""
    n = len(ring)
    flags = [on_seam(coordlookup[p], seam_type, seam_val, tol) for p in ring]
    if all(flags):
        # Whole fragment is a degenerate closing stub hugging the seam (no
        # real interior vertices at all on this side) — it contributes
        # nothing but the artifact itself.
        return 'EMPTY'
    if not any(flags):
        return None
    start = next(i for i in range(n) if not flags[i])
    rot = ring[start:] + ring[:start]
    rflags = flags[start:] + flags[:start]
    groups = []
    i = 0
    while i < n:
        if rflags[i]:
            j = i
            while j < n and rflags[j]:
                j += 1
            groups.append((i, j))
            i = j
        else:
            i += 1
    if len(groups) != 1:
        return None
    gi, gj = groups[0]
    before = rot[gi - 1]
    after = rot[gj % n]
    chain = rot[gj:] + rot[:gi]
    return chain, before, after


key_sheets = {}
for sid, sh in sheets.items():
    for key in sh['bnp']:
        key_sheets.setdefault(key, []).append(sid)

merged_parcels = {}
skipped = []

for key, sids in key_sheets.items():
    if len(sids) == 1:
        sid = sids[0]
        ring = [(sid, idx) for idx in sheets[sid]['bnp'][key]]
        merged_parcels[key] = {'ring': ring, 'sheets': {sid}, 'spliced': False}
        continue

    # A fragment whose own point-index list already contains a repeated
    # vertex is not a simple ring (it's really >1 loop concatenated under
    # the same 段/小段 key — e.g. an exterior ring plus a self-touching
    # loop). Splicing assumes each fragment is a single simple ring, so
    # these are left as separate, unspliced fragments rather than risk
    # producing a bowtie/self-intersecting merged polygon.
    has_dup = any(
        len(sheets[sid]['bnp'][key]) != len(set(sheets[sid]['bnp'][key]))
        for sid in sids
    )
    if has_dup:
        skipped.append((key, sids, 'fragment-has-repeated-vertex'))
        for sid in sids:
            ring = [(sid, idx) for idx in sheets[sid]['bnp'][key]]
            merged_parcels[(key, sid)] = {'ring': ring, 'sheets': {sid}, 'spliced': False, 'note': 'non-simple-fragment'}
        continue

    parent = {s: s for s in sids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
            return True
        return False

    sidset = set(sids)
    relevant_edges = []
    for e in adjacency:
        a = e.get('top', e.get('west'))
        b = e.get('bottom', e.get('east'))
        if a in sidset and b in sidset:
            # Each sheet's own frame-hugging artifact follows ITS OWN bbox
            # edge, not the shared/averaged seam value — the two sheets'
            # frames don't line up exactly (uncorrected seam mismatch), so
            # using the averaged seam as a single tolerance target misses
            # points that hug one sheet's own edge a couple metres off from
            # the other's.
            ay0, ax0, ay1, ax1 = sheets[a]['bbox']
            by0, bx0, by1, bx1 = sheets[b]['bbox']
            if e['type'] == 'h':
                seamA, seamB = ay0, by1
            else:
                seamA, seamB = ax1, bx0
            relevant_edges.append((a, b, e['type'], seamA, seamB))

    tree_edges = [e for e in relevant_edges if union(e[0], e[1])]

    roots = set(find(s) for s in sids)
    if len(roots) != 1:
        skipped.append((key, sids, 'not-fully-connected'))
        for sid in sids:
            ring = [(sid, idx) for idx in sheets[sid]['bnp'][key]]
            merged_parcels[(key, sid)] = {'ring': ring, 'sheets': {sid}, 'spliced': False, 'note': 'unconnected-fragment'}
        continue

    group_ring = {sid: [(sid, idx) for idx in sheets[sid]['bnp'][key]] for sid in sids}
    group_of = {sid: sid for sid in sids}

    ok = True
    for (a, b, etype, seamA, seamB) in tree_edges:
        ga, gb = group_of[a], group_of[b]
        if ga == gb:
            continue
        ringA = group_ring[ga]
        ringB = group_ring[gb]
        cutA = cut_ring_at_seam(ringA, etype, seamA)
        cutB = cut_ring_at_seam(ringB, etype, seamB)
        if cutA is None or cutB is None:
            skipped.append((key, sids, f'no-seam-run {a}-{b} type={etype} seamA={seamA} seamB={seamB}'))
            ok = False
            break
        if cutA == 'EMPTY' and cutB == 'EMPTY':
            skipped.append((key, sids, f'both-sides-empty {a}-{b}'))
            ok = False
            break
        elif cutA == 'EMPTY':
            new_ring = cutB[0]
        elif cutB == 'EMPTY':
            new_ring = cutA[0]
        else:
            chainA, beforeA, afterA = cutA
            chainB, beforeB, afterB = cutB
            new_ring = chainA + chainB
        new_group_id = gb
        group_ring[new_group_id] = new_ring
        for s in sids:
            if group_of[s] == ga or group_of[s] == gb:
                group_of[s] = new_group_id
    if not ok:
        for sid in sids:
            ring = [(sid, idx) for idx in sheets[sid]['bnp'][key]]
            merged_parcels[(key, sid)] = {'ring': ring, 'sheets': {sid}, 'spliced': False, 'note': 'splice-failed'}
        continue

    final_groups = set(group_of.values())
    assert len(final_groups) == 1, (key, final_groups)
    final_ring = group_ring[final_groups.pop()]
    merged_parcels[key] = {'ring': final_ring, 'sheets': set(sids), 'spliced': True}

n_spliced = sum(1 for v in merged_parcels.values() if v.get('spliced'))
print(f'總處理 key 數: {len(merged_parcels)}  成功接圖: {n_spliced}  跳過/失敗: {len(skipped)}')
for s in skipped[:30]:
    print('  skip:', s)

with open('merged_parcels.pkl', 'wb') as f:
    pickle.dump({'merged_parcels': merged_parcels, 'coordlookup': coordlookup, 'skipped': skipped}, f)
print('saved merged_parcels.pkl')
