let _map = null;
const layers = {};

export function initMap(containerId) {
  _map = L.map(containerId, { zoomControl: true }).setView([23.9, 121.0], 8);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 20,
  }).addTo(_map);

  layers.original = L.layerGroup().addTo(_map);
  layers.fitted = L.layerGroup().addTo(_map);
  layers.survey = L.layerGroup().addTo(_map);
  layers.adjusted = L.layerGroup().addTo(_map);

  const overlays = {
    '原始地籍線': layers.original,
    '套合結果': layers.fitted,
    '現況點': layers.survey,
    '調整後地籍線': layers.adjusted,
  };
  L.control.layers(null, overlays, { collapsed: false }).addTo(_map);

  _map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircle: false });

  return _map;
}

export function clearLayer(name) {
  if (layers[name]) layers[name].clearLayers();
}

export function showOriginalCadastral(geojson) {
  clearLayer('original');
  L.geoJSON(geojson, {
    style: { color: '#6b7280', weight: 1.5, opacity: 0.8 },
  }).addTo(layers.original);
}

export function showFittedCadastral(geojson) {
  clearLayer('fitted');
  L.geoJSON(geojson, {
    style: { color: '#f97316', weight: 2, opacity: 0.9 },
    pointToLayer: (f, latlng) =>
      L.circleMarker(latlng, { radius: 5, color: '#ea580c', fillOpacity: 0.8 })
        .bindTooltip(f.properties?.id || ''),
  }).addTo(layers.fitted);
  fitBoundsToLayer('fitted');
}

export function showSurveyPoints(geojson) {
  clearLayer('survey');
  L.geoJSON(geojson, {
    pointToLayer: (f, latlng) =>
      L.circleMarker(latlng, { radius: 6, color: '#2563eb', fillColor: '#60a5fa', fillOpacity: 0.9 })
        .bindTooltip(f.properties?.id || ''),
  }).addTo(layers.survey);
}

export function showAdjustedLines(before, after) {
  clearLayer('adjusted');
  if (before) {
    L.geoJSON(before, {
      style: { color: '#ef4444', weight: 2, dashArray: '6 4', opacity: 0.8 },
    }).addTo(layers.adjusted);
  }
  if (after) {
    L.geoJSON(after, {
      style: { color: '#22c55e', weight: 2, opacity: 0.9 },
    }).addTo(layers.adjusted);
  }
  fitBoundsToLayer('adjusted');
}

function fitBoundsToLayer(name) {
  const group = layers[name];
  if (group && group.getLayers().length) {
    try { _map.fitBounds(group.getBounds().pad(0.1)); } catch (_) {}
  }
}
