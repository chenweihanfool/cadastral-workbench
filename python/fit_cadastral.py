"""
fit_cadastral.py — Cadastral map fitting algorithm (Pyodide browser edition).

Inputs (set as pyodide globals before calling):
  kc_points_json    : JSON string — list of {id, n, e} for KC cadastral points
  survey_points_json: JSON string — list of {id, n, e} for field survey points
  init_theta        : float — initial rotation angle in degrees
  case_no           : str — case identifier

Output (set as pyodide global after completion):
  result_json: JSON string matching FitResult interface expected by fit_module.js

Algorithm: 4-parameter Helmert transformation (2D similarity)
  X' = tx + s*(X*cos(θ) - Y*sin(θ))
  Y' = ty + s*(X*sin(θ) + Y*cos(θ))

Uses scipy L-BFGS-B optimisation (same as fit-cadastral repo).
See https://github.com/chenweihanfool/fit-cadastral for full implementation.
"""

import json
import math
import numpy as np
from scipy.optimize import minimize

# ── Load inputs ───────────────────────────────────────────────────────────────
kc_pts = json.loads(kc_points_json)      # noqa: F821
sv_pts = json.loads(survey_points_json)  # noqa: F821
_init_theta_deg = float(init_theta)      # noqa: F821
_case_no = str(case_no)                  # noqa: F821


def _match_points(kc, sv):
    """Match survey points to KC points by id prefix."""
    kc_map = {p['id'].strip(): p for p in kc}
    matched_kc, matched_sv = [], []
    for sp in sv:
        key = sp['id'].strip()
        if key in kc_map:
            matched_kc.append(kc_map[key])
            matched_sv.append(sp)
    return matched_kc, matched_sv


def _apply_transform(pts, tx, ty, theta_rad, scale=1.0):
    cos_t, sin_t = math.cos(theta_rad), math.sin(theta_rad)
    result = []
    for p in pts:
        x_new = tx + scale * (p['e'] * cos_t - p['n'] * sin_t)
        y_new = ty + scale * (p['e'] * sin_t + p['n'] * cos_t)
        result.append({'id': p['id'], 'e': x_new, 'n': y_new})
    return result


def _rmse(transformed, target):
    errors = []
    t_map = {p['id'].strip(): p for p in target}
    for p in transformed:
        key = p['id'].strip()
        if key in t_map:
            dx = p['e'] - t_map[key]['e']
            dy = p['n'] - t_map[key]['n']
            errors.append(dx ** 2 + dy ** 2)
    return math.sqrt(sum(errors) / len(errors)) if errors else 999.0


def _objective(params, src_pts, dst_pts):
    tx, ty, theta_deg = params
    transformed = _apply_transform(src_pts, tx, ty, math.radians(theta_deg))
    return _rmse(transformed, dst_pts)


# ── Match & compute ───────────────────────────────────────────────────────────
matched_kc, matched_sv = _match_points(kc_pts, sv_pts)

if len(matched_sv) < 2:
    # Fallback: use centroid alignment if no ID matches
    kc_arr = np.array([[p['e'], p['n']] for p in kc_pts])
    sv_arr = np.array([[p['e'], p['n']] for p in sv_pts])
    centroid_kc = kc_arr.mean(axis=0)
    centroid_sv = sv_arr.mean(axis=0)
    init_tx = centroid_sv[0] - centroid_kc[0]
    init_ty = centroid_sv[1] - centroid_kc[1]
    matched_kc = kc_pts[:max(2, len(kc_pts))]
    matched_sv = sv_pts[:len(matched_kc)]
else:
    init_tx = np.mean([p['e'] for p in matched_sv]) - np.mean([p['e'] for p in matched_kc])
    init_ty = np.mean([p['n'] for p in matched_sv]) - np.mean([p['n'] for p in matched_kc])

rmse_before = _rmse(
    _apply_transform(matched_kc, init_tx, init_ty, math.radians(_init_theta_deg)),
    matched_sv
)

opt = minimize(
    _objective,
    x0=[init_tx, init_ty, _init_theta_deg],
    args=(matched_kc, matched_sv),
    method='L-BFGS-B',
    options={'maxiter': 1000, 'ftol': 1e-12},
)

best_tx, best_ty, best_theta_deg = opt.x

# Transform ALL KC points with optimised parameters
fitted_all = _apply_transform(kc_pts, best_tx, best_ty, math.radians(best_theta_deg))
rmse_after = _rmse(
    _apply_transform(matched_kc, best_tx, best_ty, math.radians(best_theta_deg)),
    matched_sv
)

# ── Build GeoJSON for Leaflet display (approximate WGS84) ────────────────────
def _twd97_to_wgs84(e, n):
    lon = (e - 250000) / 111320 + 121
    lat = n / 110540
    return [lon, lat]


fitted_geojson = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": _twd97_to_wgs84(p['e'], p['n'])},
            "properties": {"id": p['id'], "n": p['n'], "e": p['e']},
        }
        for p in fitted_all
    ],
}

# ── Output ────────────────────────────────────────────────────────────────────
result_json = json.dumps({               # noqa: F841
    "theta": best_theta_deg,
    "tx": best_tx,
    "ty": best_ty,
    "rmseBefore": rmse_before,
    "rmseAfter": rmse_after,
    "fittedPoints": fitted_all,
    "fittedGeoJSON": fitted_geojson,
    "caseNo": _case_no,
})
