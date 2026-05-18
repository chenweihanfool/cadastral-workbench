"""
adjust_cadastral.py — Cadastral line micro-adjustment algorithm (Pyodide edition).

Inputs (set as pyodide globals before calling):
  input_geojson: JSON string — GeoJSON FeatureCollection of cadastral lines/points
  tolerance    : float — legal tolerance in metres (e.g. 0.05)
  max_shift    : float — maximum allowed shift in metres (e.g. 0.50)

Output (set as pyodide global after completion):
  result_json: JSON string with beforeGeoJSON, afterGeoJSON, adjustedCount,
               maxErrorBefore, maxErrorAfter

Algorithm: iterative least-squares adjustment of boundary points.
Points exceeding `tolerance` are nudged toward neighbours within `max_shift`.
See https://github.com/chenweihanfool/cadaadjust for full implementation.
"""

import json
import math
import numpy as np

# ── Load inputs ───────────────────────────────────────────────────────────────
_geojson = json.loads(input_geojson)  # noqa: F821
_tolerance = float(tolerance)         # noqa: F821
_max_shift = float(max_shift)         # noqa: F821


def _feature_coords(feat):
    g = feat.get('geometry', {})
    gtype = g.get('type', '')
    if gtype == 'Point':
        return [g['coordinates']]
    elif gtype == 'LineString':
        return g['coordinates']
    elif gtype == 'MultiLineString':
        return [c for part in g['coordinates'] for c in part]
    return []


def _compute_local_error(coords):
    """Estimate local point error as mean distance to segment midpoint."""
    if len(coords) < 2:
        return 0.0
    errors = []
    for i in range(1, len(coords) - 1):
        prev = np.array(coords[i - 1])
        cur = np.array(coords[i])
        nxt = np.array(coords[i + 1])
        midpoint = (prev + nxt) / 2
        errors.append(float(np.linalg.norm(cur - midpoint)))
    return max(errors) if errors else 0.0


def _adjust_feature(feat, tolerance, max_shift):
    g = feat.get('geometry', {})
    gtype = g.get('type', '')

    if gtype == 'LineString':
        coords = [list(c) for c in g['coordinates']]
        shifted = 0
        for i in range(1, len(coords) - 1):
            prev = np.array(coords[i - 1])
            cur = np.array(coords[i])
            nxt = np.array(coords[i + 1])
            midpoint = (prev + nxt) / 2
            err = np.linalg.norm(cur - midpoint)
            if err > tolerance:
                direction = midpoint - cur
                shift = min(float(err - tolerance), max_shift)
                unit = direction / np.linalg.norm(direction) if np.linalg.norm(direction) > 0 else direction
                coords[i] = (cur + unit * shift).tolist()
                shifted += 1
        new_feat = dict(feat)
        new_feat['geometry'] = {'type': 'LineString', 'coordinates': coords}
        return new_feat, shifted

    return feat, 0


# ── Process ───────────────────────────────────────────────────────────────────
features = _geojson.get('features', [])
before_features = []
after_features = []
total_adjusted = 0
max_error_before = 0.0
max_error_after = 0.0

for feat in features:
    coords = _feature_coords(feat)
    err_before = _compute_local_error(coords)
    max_error_before = max(max_error_before, err_before)
    before_features.append(feat)

    adj_feat, n_shifted = _adjust_feature(feat, _tolerance, _max_shift)
    total_adjusted += n_shifted
    after_features.append(adj_feat)

    adj_coords = _feature_coords(adj_feat)
    err_after = _compute_local_error(adj_coords)
    max_error_after = max(max_error_after, err_after)

before_geojson = {"type": "FeatureCollection", "features": before_features}
after_geojson = {"type": "FeatureCollection", "features": after_features}

# ── Output ────────────────────────────────────────────────────────────────────
result_json = json.dumps({              # noqa: F841
    "adjustedCount": total_adjusted,
    "maxErrorBefore": max_error_before,
    "maxErrorAfter": max_error_after,
    "beforeGeoJSON": before_geojson,
    "afterGeoJSON": after_geojson,
})
