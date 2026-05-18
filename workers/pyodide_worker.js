importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js');

let pyodide = null;
let fitScript = null;
let adjustScript = null;

async function initPyodide() {
  pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/' });
  await pyodide.loadPackage(['numpy', 'scipy']);

  // Fetch Python scripts from relative path (works under GitHub Pages)
  const base = self.location.href.replace('/workers/pyodide_worker.js', '');
  const [fitRes, adjRes] = await Promise.all([
    fetch(`${base}/python/fit_cadastral.py`),
    fetch(`${base}/python/adjust_cadastral.py`),
  ]);
  fitScript = await fitRes.text();
  adjustScript = await adjRes.text();

  self.postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    try {
      await initPyodide();
    } catch (err) {
      self.postMessage({ type: 'error', payload: 'Pyodide 初始化失敗：' + err.message });
    }
    return;
  }

  if (!pyodide) {
    self.postMessage({ type: 'error', payload: 'Pyodide 尚未初始化' });
    return;
  }

  if (type === 'run_fit') {
    try {
      const result = await runFit(payload);
      self.postMessage({ type: 'fit_result', payload: result });
    } catch (err) {
      self.postMessage({ type: 'error', payload: '套合運算錯誤：' + err.message });
    }
  } else if (type === 'run_adjust') {
    try {
      const result = await runAdjust(payload);
      self.postMessage({ type: 'adjust_result', payload: result });
    } catch (err) {
      self.postMessage({ type: 'error', payload: '調整運算錯誤：' + err.message });
    }
  }
};

async function runFit({ kcData, surveyPoints, initTheta, caseNo }) {
  // Pass data into Python via pyodide globals
  pyodide.globals.set('kc_points_json', JSON.stringify(kcData.points));
  pyodide.globals.set('survey_points_json', JSON.stringify(surveyPoints));
  pyodide.globals.set('init_theta', initTheta);
  pyodide.globals.set('case_no', caseNo);

  // Run the fit script — it must set `result_json` as output
  pyodide.runPython(fitScript);
  const resultJson = pyodide.globals.get('result_json');
  return JSON.parse(resultJson);
}

async function runAdjust({ geojson, tolerance, maxShift }) {
  pyodide.globals.set('input_geojson', JSON.stringify(geojson));
  pyodide.globals.set('tolerance', tolerance);
  pyodide.globals.set('max_shift', maxShift);

  pyodide.runPython(adjustScript);
  const resultJson = pyodide.globals.get('result_json');
  return JSON.parse(resultJson);
}
