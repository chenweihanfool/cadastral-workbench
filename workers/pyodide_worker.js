/* ── Pyodide Worker ──────────────────────────────────────────────────────── */
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js');

let pyodide   = null;
let fitScript = null;
let adjScript = null;
let crsScript = null;

// Python globals persisted between runPython() calls in the same interpreter
// segs / ref_pts / boundary_pts / cy / cx  — kept alive after 'parse' call
// coa_points / parcel_points / parcel_info / pt_index — kept alive after adj parse

async function _init() {
  pyodide = await loadPyodide({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/',
  });
  await pyodide.loadPackage(['numpy', 'scipy']);

  // Fetch Python scripts relative to the repo root
  const base = self.location.href.replace(/\/workers\/[^/]+$/, '');
  const [fRes, aRes, cRes] = await Promise.all([
    fetch(`${base}/python/fit_cadastral.py`),
    fetch(`${base}/python/adjust_cadastral.py`),
    fetch(`${base}/python/crs_transform.py`),
  ]);
  if (!fRes.ok) throw new Error('Cannot fetch fit_cadastral.py');
  if (!aRes.ok) throw new Error('Cannot fetch adjust_cadastral.py');
  if (!cRes.ok) throw new Error('Cannot fetch crs_transform.py');
  fitScript = await fRes.text();
  adjScript = await aRes.text();
  crsScript = await cRes.text();

  self.postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    try {
      await _init();
    } catch (err) {
      self.postMessage({ type: 'error', payload: 'Pyodide 初始化失敗：' + err.message });
    }
    return;
  }

  if (!pyodide) {
    self.postMessage({ type: 'error', payload: 'Pyodide 未就緒' });
    return;
  }

  try {
    switch (type) {

      // ── FIT: parse DBF files ──────────────────────────────────────────────
      case 'fit_parse': {
        pyodide.globals.set('d14_buf', new Uint8Array(payload.d14));
        pyodide.globals.set('d2c_buf', new Uint8Array(payload.d2c));
        pyodide.globals.set('d2d_buf', new Uint8Array(payload.d2d));
        pyodide.globals.set('d2b_buf', new Uint8Array(payload.d2b));
        pyodide.globals.set('fit_mode', 'parse');
        pyodide.runPython(fitScript);
        const result = JSON.parse(pyodide.globals.get('result_json'));
        self.postMessage({ type: 'fit_parse_result', payload: result });
        break;
      }

      // ── FIT: run optimisation ─────────────────────────────────────────────
      case 'fit_run': {
        pyodide.globals.set('weights_json', JSON.stringify(payload.weights || {}));
        pyodide.globals.set('fit_mode', 'fit');
        pyodide.runPython(fitScript);
        const result = JSON.parse(pyodide.globals.get('result_json'));
        self.postMessage({ type: 'fit_run_result', payload: result });
        break;
      }

      // ── ADJUST: parse COA/BNP/PAR files ──────────────────────────────────
      case 'adj_parse': {
        pyodide.globals.set('coa_buf', new Uint8Array(payload.coa));
        pyodide.globals.set('bnp_buf', new Uint8Array(payload.bnp));
        pyodide.globals.set('par_buf', new Uint8Array(payload.par));
        pyodide.globals.set('adj_mode', 'parse');
        pyodide.runPython(adjScript);
        const result = JSON.parse(pyodide.globals.get('result_json'));
        self.postMessage({ type: 'adj_parse_result', payload: result });
        break;
      }

      // ── ADJUST: run adjustment ────────────────────────────────────────────
      case 'adj_run': {
        pyodide.globals.set('target_keys_json', JSON.stringify(payload.targetKeys || []));
        pyodide.globals.set('max_shift_json',   JSON.stringify(payload.maxShiftM !== undefined ? payload.maxShiftM : 0.30));
        pyodide.globals.set('adj_mode', 'adjust');
        pyodide.runPython(adjScript);
        const result = JSON.parse(pyodide.globals.get('result_json'));
        self.postMessage({ type: 'adj_run_result', payload: result });
        break;
      }

      // ── CRS: TWD67 → TWD97 conversion ────────────────────────────────────
      case 'crs_convert': {
        pyodide.globals.set('crs_mode', 'convert');
        pyodide.globals.set('crs_pts_json', JSON.stringify(payload.pts));
        pyodide.runPython(crsScript);
        const result = JSON.parse(pyodide.globals.get('result_json'));
        self.postMessage({ type: 'crs_result', payload: result });
        break;
      }

      default:
        self.postMessage({ type: 'error', payload: '未知訊息類型：' + type });
    }
  } catch (err) {
    self.postMessage({ type: 'error', payload: err.message });
  }
};
