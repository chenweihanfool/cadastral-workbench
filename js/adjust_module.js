import { showAdjustedLines } from './map.js';
import { writeAdjustGPKG } from './gpkg_writer.js';

export class AdjustModule {
  constructor(map, appCtx) {
    this._map = map;
    this._app = appCtx;

    this.tolerance = 0.05;
    this.maxShift = 0.5;
    this.running = false;
    this.result = null;
    this.fromFit = false;

    this._inputData = null;
  }

  loadFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (file.name.endsWith('.geojson') || file.name.endsWith('.json')) {
        try {
          this._inputData = JSON.parse(e.target.result);
          this.fromFit = false;
          this._app.setStatus(`調整模組：已載入 ${file.name}`);
        } catch (err) {
          alert('GeoJSON 解析失敗：' + err.message);
        }
      } else if (file.name.endsWith('.gpkg')) {
        alert('瀏覽器端 .gpkg 讀取功能開發中，請先使用 GeoJSON 輸入');
      }
    };
    reader.readAsText(file);
  }

  loadFromFit(fitResult) {
    this._inputData = fitResult.fittedGeoJSON;
    this.fromFit = true;
    this._app.setStatus('調整模組：已帶入套圖成果');
  }

  run() {
    if (!this._inputData) return alert('請先載入地籍線資料');
    this.running = true;
    this._app.setStatus('調整運算中…');
    this._app.runAdjust({
      geojson: this._inputData,
      tolerance: parseFloat(this.tolerance),
      maxShift: parseFloat(this.maxShift),
    });
  }

  onResult(payload) {
    this.running = false;
    this.result = payload;
    showAdjustedLines(payload.beforeGeoJSON, payload.afterGeoJSON);
    this._app.setStatus(
      `調整完成｜${payload.adjustedCount} 點調整，最大較差 ${payload.maxErrorAfter?.toFixed(3)} m`
    );
  }

  async exportGPKG() {
    if (!this.result) return;
    this._app.setStatus('產生 GeoPackage…');
    await writeAdjustGPKG(this.result);
    this._app.setStatus('GeoPackage 已下載');
  }
}
