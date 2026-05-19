/* ── CadastralWorkbench — DXF writer (AC1015 / R2000) ─────────────────────
   Generates a minimal AutoCAD-compatible DXF for one adjusted parcel.

   Layers
     ADJ_BEFORE  color 1 (red)   — original boundary
     ADJ_AFTER   color 3 (green) — adjusted boundary
     LABEL       color 7 (white) — parcel-number text at centroid

   Coordinate system: TWD97 (EPSG:3826), unit = metres.
   Input coords format: [[northing Y, easting X], ...]
   DXF convention:      group 10 = X = easting,  group 20 = Y = northing
─────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} parcel  element of ADJ.result.adjusted_parcels
 *   .label          {string}   "70-0"
 *   .coords_before  {number[][]}  [[Y,X], ...]  original coords
 *   .coords_after   {number[][]}  [[Y,X], ...]  adjusted coords
 * @returns {string} DXF file content (CRLF line endings)
 */
function writeParcelDXF(parcel) {           // eslint-disable-line no-unused-vars
  const label  = parcel.label  || 'PARCEL';
  const before = parcel.coords_before || [];
  const after  = parcel.coords_after  || [];

  if (after.length < 3) return '';

  /* ── centroid of adjusted polygon (for label placement) ── */
  const cy = after.reduce((s, c) => s + c[0], 0) / after.length;
  const cx = after.reduce((s, c) => s + c[1], 0) / after.length;

  /* ── auto text height: 8 % of shorter side, clamped 0.5 – 5 m ── */
  const ys   = after.map(c => c[0]);
  const xs   = after.map(c => c[1]);
  const span = Math.min(Math.max(...ys) - Math.min(...ys),
                        Math.max(...xs) - Math.min(...xs));
  const th   = Math.max(0.5, Math.min(5.0, span * 0.08)).toFixed(4);

  /* ── accumulate DXF lines ── */
  const L = [];
  let   h = 0x100;
  const nextHandle = () => (++h).toString(16).toUpperCase();

  /* push any number of (group-code, value) pairs */
  const p = (...args) => { for (let i = 0; i < args.length; i++) L.push(String(args[i])); };

  /* ── HEADER ─────────────────────────────────────────────────────────── */
  p('0', 'SECTION', '2', 'HEADER');
  p('9', '$ACADVER',  '1',  'AC1015');  // AutoCAD 2000+
  p('9', '$INSUNITS', '70', '6');       // 6 = metres
  p('9', '$LUNITS',   '70', '2');       // decimal
  p('9', '$LUPREC',   '70', '4');       // 4 decimal places
  p('0', 'ENDSEC');

  /* ── TABLES + LAYER ─────────────────────────────────────────────────── */
  const layerDefs = [
    { name: 'ADJ_BEFORE', color: '1' },   // ACI 1 = red
    { name: 'ADJ_AFTER',  color: '3' },   // ACI 3 = green
    { name: 'LABEL',      color: '7' },   // ACI 7 = white/black
  ];
  p('0', 'SECTION', '2', 'TABLES');
  p('0', 'TABLE', '2', 'LAYER', '70', String(layerDefs.length));
  for (const { name, color } of layerDefs) {
    p('0', 'LAYER',
      '2', name,
      '70', '0',        // flags: 0 = on, thawed
      '62', color,      // ACI color
      '6',  'Continuous');
  }
  p('0', 'ENDTAB', '0', 'ENDSEC');

  /* ── ENTITIES ───────────────────────────────────────────────────────── */
  p('0', 'SECTION', '2', 'ENTITIES');

  /* helper: closed LWPOLYLINE */
  function addLWPolyline(layerName, coords) {
    if (!coords || coords.length < 3) return;
    p('0',   'LWPOLYLINE',
      '5',   nextHandle(),
      '100', 'AcDbEntity',
      '8',   layerName,
      '100', 'AcDbPolyline',
      '90',  String(coords.length),   // vertex count
      '70',  '1',                     // 1 = closed polyline
      '43',  '0.0');                  // constant width = 0
    for (const [ny, ex] of coords) {
      p('10', ex.toFixed(4),    // DXF X = easting
        '20', ny.toFixed(4));   // DXF Y = northing
    }
  }

  addLWPolyline('ADJ_BEFORE', before);
  addLWPolyline('ADJ_AFTER',  after);

  /* TEXT label — centred at adjusted-polygon centroid */
  p('0',   'TEXT',
    '5',   nextHandle(),
    '100', 'AcDbEntity',
    '8',   'LABEL',
    '100', 'AcDbText',
    '10',  cx.toFixed(4),   // DXF X (insertion point, used when j=0)
    '20',  cy.toFixed(4),
    '30',  '0.0',
    '40',  th,              // text height
    '1',   label,           // text string
    '72',  '1',             // horizontal justification: 1 = centre
    '11',  cx.toFixed(4),   // alignment point X
    '21',  cy.toFixed(4),   // alignment point Y
    '31',  '0.0',
    '100', 'AcDbText',      // second subclass marker required by R2000
    '73',  '2');            // vertical justification: 2 = middle

  p('0', 'ENDSEC', '0', 'EOF');

  return L.join('\r\n') + '\r\n';
}
