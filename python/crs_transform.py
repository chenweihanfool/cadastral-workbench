# ── crs_transform.py  TWD67/TM2 → TWD97/TM2 ─────────────────────────────────
# 內政部公告三參數 Helmert 轉換
# ΔX = -752.354, ΔY = -155.968, ΔZ = 526.748
# TWD67: Bessel 1841  a=6377397.155  f=1/299.1528128
# TWD97: GRS80        a=6378137.0    f=1/298.257222101
# TM2 zone 121: CM=121°E  k0=0.9999  FE=250000  FN=0

import math
import json

# ── 橢球體參數 ─────────────────────────────────────────────────────────────────
def _ellipsoid(a, inv_f):
    f = 1.0 / inv_f
    b = a * (1 - f)
    e2 = 2*f - f*f
    return a, b, e2

A67, B67, E2_67 = _ellipsoid(6377397.155,  299.1528128)
A97, B97, E2_97 = _ellipsoid(6378137.0,    298.257222101)

# Helmert 平移量（公尺，地心直角座標系）
DX = -752.354
DY = -155.968
DZ =  526.748

# TM2 zone 121 投影參數
CM   = math.radians(121.0)   # 中央子午線
K0   = 0.9999
FE   = 250000.0
FN   = 0.0

# ── TM 正投影 (lat/lon → N/E) ─────────────────────────────────────────────────
def _tm_forward(lat_r, lon_r, a, e2):
    e4 = e2*e2; e6 = e2*e4
    n  = a / math.sqrt(1 - e2*math.sin(lat_r)**2)
    t  = math.tan(lat_r)**2
    c  = e2/(1-e2) * math.cos(lat_r)**2
    A_ = math.cos(lat_r) * (lon_r - CM)
    # 子午線弧長
    M  = a * ((1 - e2/4 - 3*e4/64 - 5*e6/256)*lat_r
              - (3*e2/8 + 3*e4/32 + 45*e6/1024)*math.sin(2*lat_r)
              + (15*e4/256 + 45*e6/1024)*math.sin(4*lat_r)
              - (35*e6/3072)*math.sin(6*lat_r))
    x = K0*n*(A_ + (1-t+c)*A_**3/6
              + (5-18*t+t**2+72*c-58*e2/(1-e2))*A_**5/120)
    y = K0*(M + n*math.tan(lat_r)*(A_**2/2
              + (5-t+9*c+4*c**2)*A_**4/24
              + (61-58*t+t**2+600*c-330*e2/(1-e2))*A_**6/720))
    return y + FN, x + FE   # (N, E)

# ── TM 逆投影 (N/E → lat/lon) ─────────────────────────────────────────────────
def _tm_inverse(N, E, a, e2):
    e4 = e2*e2; e6 = e2*e4
    e1 = (1 - math.sqrt(1-e2)) / (1 + math.sqrt(1-e2))
    M  = (N - FN) / K0
    mu = M / (a*(1 - e2/4 - 3*e4/64 - 5*e6/256))
    phi1 = (mu
            + (3*e1/2 - 27*e1**3/32)*math.sin(2*mu)
            + (21*e1**2/16 - 55*e1**4/32)*math.sin(4*mu)
            + (151*e1**3/96)*math.sin(6*mu)
            + (1097*e1**4/512)*math.sin(8*mu))
    n1  = a / math.sqrt(1 - e2*math.sin(phi1)**2)
    r1  = a*(1-e2) / (1 - e2*math.sin(phi1)**2)**1.5
    t1  = math.tan(phi1)**2
    c1  = e2/(1-e2)*math.cos(phi1)**2
    D   = (E - FE) / (n1*K0)
    lat = phi1 - (n1*math.tan(phi1)/r1)*(D**2/2
                  - (5+3*t1+10*c1-4*c1**2-9*e2/(1-e2))*D**4/24
                  + (61+90*t1+298*c1+45*t1**2-252*e2/(1-e2)-3*c1**2)*D**6/720)
    lon = CM + (D - (1+2*t1+c1)*D**3/6
                  + (5-2*c1+28*t1-3*c1**2+8*e2/(1-e2)+24*t1**2)*D**5/120) / math.cos(phi1)
    return lat, lon

# ── 橢球 → 地心直角 ──────────────────────────────────────────────────────────
def _ell_to_xyz(lat_r, lon_r, a, e2):
    n = a / math.sqrt(1 - e2*math.sin(lat_r)**2)
    X = n * math.cos(lat_r) * math.cos(lon_r)
    Y = n * math.cos(lat_r) * math.sin(lon_r)
    Z = n * (1-e2) * math.sin(lat_r)
    return X, Y, Z

# ── 地心直角 → 橢球 (迭代法) ─────────────────────────────────────────────────
def _xyz_to_ell(X, Y, Z, a, e2):
    lon_r = math.atan2(Y, X)
    p     = math.sqrt(X**2 + Y**2)
    lat_r = math.atan2(Z, p*(1-e2))
    for _ in range(10):
        n   = a / math.sqrt(1 - e2*math.sin(lat_r)**2)
        lat_r = math.atan2(Z + e2*n*math.sin(lat_r), p)
    return lat_r, lon_r

# ── 單點轉換 TWD67/TM2 → TWD97/TM2 ──────────────────────────────────────────
def convert_point(N67, E67):
    lat67, lon67 = _tm_inverse(N67, E67, A67, E2_67)
    X67, Y67, Z67 = _ell_to_xyz(lat67, lon67, A67, E2_67)
    X97 = X67 + DX
    Y97 = Y67 + DY
    Z97 = Z67 + DZ
    lat97, lon97 = _xyz_to_ell(X97, Y97, Z97, A97, E2_97)
    N97, E97 = _tm_forward(lat97, lon97, A97, E2_97)
    return N97, E97

# ── 主程式進入點 ──────────────────────────────────────────────────────────────
if crs_mode == 'convert':
    pts_in  = json.loads(crs_pts_json)   # [[N67,E67], ...]
    pts_out = []
    sum_dn  = 0.0
    sum_de  = 0.0
    for N67, E67 in pts_in:
        N97, E97 = convert_point(N67, E67)
        pts_out.append([N97, E97])
        sum_dn += N97 - N67
        sum_de += E97 - E67
    n = len(pts_in) or 1
    result_json = json.dumps({
        'pts':     pts_out,
        'mean_dn': sum_dn / n,
        'mean_de': sum_de / n,
    })
