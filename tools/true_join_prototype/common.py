import re

def _lines(text):
    return text.split('\r\n') if '\r\n' in text else text.splitlines()

def parse_coa(text):
    pts = {}
    for l in _lines(text)[1:]:
        if len(l) < 37: continue
        idx = l[0:5].strip()
        if not idx: continue
        try:
            y = float(l[6:22]); x = float(l[22:37])
        except ValueError: continue
        pts[int(idx)] = (y, x)
    return pts

_LEADING_INT_RE = re.compile(r'\s*(\d+)')
def parse_bnp(text):
    parcels = {}
    for l in _lines(text)[1:]:
        if not l.strip(): continue
        if len(l) < 15: continue
        try:
            sec = int(l[0:4]); sub = int(l[4:8]); seq = int(l[8:11])
        except ValueError: continue
        m = _LEADING_INT_RE.match(l[11:15])
        if not m: continue
        total = int(m.group(1))
        rest = l[15:]
        idxs = []
        for i in range(0, len(rest), 6):
            slot = rest[i:i+6]
            if not slot.strip(): continue
            try: idxs.append(int(slot))
            except ValueError:
                mm = _LEADING_INT_RE.match(slot)
                if mm: idxs.append(int(mm.group(1)))
        parcels.setdefault((sec,sub), {})[seq] = idxs
    polys = {}
    for key, parts in parcels.items():
        idxs=[]
        for s in sorted(parts): idxs.extend(parts[s])
        polys[key]=idxs
    return polys

def parse_par(text):
    recs = {}
    for l in _lines(text)[1:]:
        if len(l) < 40: continue
        try:
            sec = int(l[0:4]); sub = int(l[4:8])
            area_reg = float(l[12:22]); area_calc = float(l[30:40])
        except ValueError: continue
        recs[(sec,sub)] = {'area_reg':area_reg,'area_calc':area_calc}
    return recs

def shoelace(ring):
    n=len(ring); s=0.0
    for i in range(n):
        y1,x1=ring[i]; y2,x2=ring[(i+1)%n]
        s += x1*y2-x2*y1
    return abs(s)/2
