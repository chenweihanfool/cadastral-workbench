import { showOriginalCadastral, showFittedCadastral, showSurveyPoints } from './map.js';
import { writeFitGPKG } from './gpkg_writer.js';
import { exportCoordTXT } from './export.js';
import { parseKCFile, parseSurveyCSV, kcToGeoJSON } from './kc_parser.js';

export class FitModule {
  constructor(map, appCtx) {
    this._map = map;
    this._app = appCtx;

    this.caseNo = '';
    this.initTheta = 0;
    this.running = false;
    this.result = null;

    this._kcData = null;
    this._surveyPts = null;
  }

  loadKCFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        this._kcData = parseKCFile(e.target.result);
        showOriginalCadastral(kcToGeoJSON(this._kcData));
        this._app.setStatus(`KC 檔已載入：${file.name}（${this._kcData.points?.length ?? 0} 點）`);
      } catch (err) {
        alert('KC 檔解析失敗：' + err.message);
      }
    };
    reader.readAsText(file, 'Big5');
  }

  loadSurveyCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        this._surveyPts = parseSurveyCSV(e.target.result);
        showSurveyPoints(this._surveyToGeoJSON());
        this._app.setStatus(`現況點已載入：${file.name}（${this._surveyPts.length} 點）`);
      } catch (err) {
        alert('CSV 解析失敗：' + err.message);
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  run() {
    if (!this._kcData) return alert('請先上傳 KC 地籍資料');
    if (!this._surveyPts) return alert('請先上傳現況點 CSV');
    this.running = true;
    this._app.setStatus('套合運算中…');
    this._app.runFit({
      kcData: this._kcData,
      surveyPoints: this._surveyPts,
      initTheta: parseFloat(this.initTheta) || 0,
      caseNo: this.caseNo || 'CASE_' + Date.now(),
    });
  }

  onResult(payload) {
    this.running = false;
    this.result = payload;
    showFittedCadastral(payload.fittedGeoJSON);
    this._app.setStatus(
      `套合完成｜RMSE 前 ${payload.rmseBefore?.toFixed(3)} m → 後 ${payload.rmseAfter?.toFixed(3)} m`
    );
    this._app.aiExplain.text = '';
  }

  exportTXT() {
    if (!this.result) return;
    exportCoordTXT(this.result.fittedPoints, this.caseNo || 'fit_result');
  }

  async exportGPKG() {
    if (!this.result) return;
    this._app.setStatus('產生 GeoPackage…');
    await writeFitGPKG(this.result, this._kcData, this.caseNo || 'fit_result');
    this._app.setStatus('GeoPackage 已下載');
  }

  sendToAdjust() {
    if (!this.result) return;
    this._app.adjustModule.loadFromFit(this.result);
    this._app.activeModule = 'adjust';
  }

  _surveyToGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: this._surveyPts.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: twd97ToWgs84(p.e, p.n) },
        properties: { id: p.id, n: p.n, e: p.e },
      })),
    };
  }
}

function twd97ToWgs84(e, n) {
  // Approximate TWD97/TM2 → WGS84 for Leaflet display
  // For production, use proj4js with EPSG:3826
  const lon = (e - 250000) / 111320 + 121;
  const lat = n / 110540;
  return [lon, lat];
}
