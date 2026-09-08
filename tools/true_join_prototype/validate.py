import sys, pickle
sys.path.insert(0, '.')
from common import shoelace
from shapely.geometry import Polygon

with open('sheets.pkl', 'rb') as f:
    sheets = pickle.load(f)
with open('merged_parcels.pkl', 'rb') as f:
    d = pickle.load(f)

merged_parcels = d['merged_parcels']
coordlookup = d['coordlookup']

# area_reg (登記面積, legal/registered area) is recorded identically across
# every fragment of a split parcel — good ground truth. area_calc (計算面積)
# is per-FRAGMENT (each sheet only computes its own partial polygon's area),
# so for a multi-sheet parcel the correct comparison figure is the SUM of
# area_calc across all its fragment sheets, not any single sheet's value.
def par_area(key, sids):
    reg = None
    calc_sum = 0.0
    found = False
    for sid in sids:
        rec = sheets[sid]['par'].get(key)
        if rec:
            found = True
            if reg is None:
                reg = rec['area_reg']
            calc_sum += rec['area_calc']
    if not found:
        return None
    return {'area_reg': reg, 'area_calc': calc_sum}

n_ok = 0
n_invalid = 0
n_area_mismatch = 0
n_no_par = 0
worst = []

for key, info in merged_parcels.items():
    ring_keys = info['ring']
    coords = [coordlookup[p] for p in ring_keys]
    if len(coords) < 3:
        continue
    area_geom = shoelace(coords)
    poly = Polygon([(x, y) for y, x in coords])
    valid = poly.is_valid
    if not valid:
        n_invalid += 1

    # merged_parcels keys are either (sec,sub) for normal/spliced entries, or
    # ((sec,sub), sid) for per-sheet fallback fragments that couldn't be spliced
    is_fallback = isinstance(key[0], tuple)
    real_key = key[0] if is_fallback else key
    sids = info['sheets']
    rec = par_area(real_key, sids)
    if rec is None:
        n_no_par += 1
        continue
    area_calc = rec['area_calc']
    if area_calc <= 0:
        continue
    diff_pct = abs(area_geom - area_calc) / area_calc * 100
    worst.append((diff_pct, key, info.get('spliced'), valid, area_geom, area_calc))
    if diff_pct > 1.0:
        n_area_mismatch += 1
    else:
        n_ok += 1

worst.sort(reverse=True)
print(f'總比對筆數(有PAR面積): {n_ok+n_area_mismatch}  面積誤差<=1%: {n_ok}  面積誤差>1%: {n_area_mismatch}  無PAR對照: {n_no_par}  幾何invalid: {n_invalid}')
print('\n面積誤差最大的前20筆:')
for diff_pct, key, spliced, valid, ag, ac in worst[:20]:
    print(f'  key={key} spliced={spliced} valid={valid} diff%={diff_pct:.2f} area_geom={ag:.1f} area_calc={ac:.1f}')
