/**
 * KC format parser for Taiwan cadastral data files (D14, D2B, D2C, D2D).
 * KC format: fixed-width text, Big5 encoding.
 *
 * D14 = 界址點座標資料
 * D2B/D2C/D2D = 宗地資料 / 線段資料 / 圖形資料
 */

export function parseKCFile(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('檔案為空');

  // Auto-detect by record length / prefix
  const firstLine = lines[0];

  if (firstLine.length >= 40 && /^\d{4}/.test(firstLine)) {
    return parseD14(lines);
  }
  throw new Error('無法識別 KC 格式，請確認為 D14/D2B/D2C/D2D 檔案');
}

function parseD14(lines) {
  const points = [];
  for (const line of lines) {
    if (line.trim().length < 30) continue;
    const id = line.substring(0, 8).trim();
    const nStr = line.substring(8, 20).trim();
    const eStr = line.substring(20, 32).trim();
    const n = parseFloat(nStr);
    const e = parseFloat(eStr);
    if (!isNaN(n) && !isNaN(e)) {
      points.push({ id, n, e });
    }
  }
  if (!points.length) throw new Error('D14 檔案中未解析到有效座標');
  return { type: 'D14', points };
}

export function parseSurveyCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const points = [];
  for (const line of lines) {
    if (/[a-zA-Z]/.test(line.split(',')[0])) continue; // skip header
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 3) continue;
    const id = parts[0];
    const n = parseFloat(parts[1]);
    const e = parseFloat(parts[2]);
    if (!isNaN(n) && !isNaN(e)) {
      points.push({ id, n, e });
    }
  }
  if (!points.length) throw new Error('CSV 無有效資料，請確認格式為「點號,N,E」');
  return points;
}

export function kcToGeoJSON(kcData) {
  if (kcData.type === 'D14') {
    return {
      type: 'FeatureCollection',
      features: kcData.points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: twd97ToWgs84(p.e, p.n) },
        properties: { id: p.id, n: p.n, e: p.e },
      })),
    };
  }
  return { type: 'FeatureCollection', features: [] };
}

function twd97ToWgs84(e, n) {
  const lon = (e - 250000) / 111320 + 121;
  const lat = n / 110540;
  return [lon, lat];
}
