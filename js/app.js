import { initMap } from './map.js';
import { FitModule } from './fit_module.js';
import { AdjustModule } from './adjust_module.js';
import { AIExplain } from './ai_explain.js';

window.app = function () {
  return {
    activeModule: 'fit',
    showSettings: false,
    statusMsg: '就緒',
    pyodideStatus: '未載入',

    settings: {
      apiKey: '',
      aiProvider: 'openai',
    },

    fitModule: null,
    adjustModule: null,
    aiExplain: null,
    _map: null,

    init() {
      this.loadSettings();
      this._map = initMap('map');

      this.fitModule = new FitModule(this._map, this);
      this.adjustModule = new AdjustModule(this._map, this);
      this.aiExplain = new AIExplain(this);

      this.initPyodideWorker();
    },

    loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('cw_settings') || '{}');
        Object.assign(this.settings, saved);
      } catch (_) {}
    },

    saveSettings() {
      localStorage.setItem('cw_settings', JSON.stringify(this.settings));
      this.setStatus('設定已儲存');
    },

    setStatus(msg) {
      this.statusMsg = msg;
    },

    setPyodideStatus(s) {
      this.pyodideStatus = s;
    },

    initPyodideWorker() {
      this._worker = new Worker('./workers/pyodide_worker.js', { type: 'classic' });

      this._worker.onmessage = (e) => {
        const { type, payload } = e.data;
        if (type === 'ready') {
          this.setPyodideStatus('已就緒');
          this.setStatus('Pyodide 載入完成，可執行運算');
        } else if (type === 'fit_result') {
          this.fitModule.onResult(payload);
        } else if (type === 'adjust_result') {
          this.adjustModule.onResult(payload);
        } else if (type === 'error') {
          alert('運算錯誤：' + payload);
          this.fitModule.running = false;
          this.adjustModule.running = false;
        }
      };

      this._worker.onerror = (e) => {
        this.setPyodideStatus('載入失敗');
        console.error('Worker error:', e);
      };

      this.setPyodideStatus('載入中…');
      this._worker.postMessage({ type: 'init' });
    },

    runFit(params) {
      this._worker.postMessage({ type: 'run_fit', payload: params });
    },

    runAdjust(params) {
      this._worker.postMessage({ type: 'run_adjust', payload: params });
    },
  };
};
