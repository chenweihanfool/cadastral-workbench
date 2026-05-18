/* ── GeoPackage writer (sql.js WASM)  ─────────────────────────────────────
   全域函式 writeGPKG(opts) 由 app.js 呼叫
   opts: { filename, points?, segments?, polygons_before?, polygons_after?, metadata? }
   ─────────────────────────────────────────────────────────────────────────── */

let _SQL = null;

async function _getSql() {
  if (_SQL) return _SQL;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-asm.js';
    s.onload = async () => {
      try {
        _SQL = await initSqlJs({
          locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${f}`,
        });
        resolve(_SQL);
      } catch (e) { reject(e); }
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function writeGPKG(opts) {
  const SQL = await _getSql();
  const db  = new SQL.Database();

  // GeoPackage headers
  db.run('PRAGMA application_id = 0x47504B47');
  db.run('PRAGMA user_version  = 10300');

  // gpkg_spatial_ref_sys
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL, description TEXT)`);
  db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES
    ('TWD97 / TM2 zone 121', 3826, 'EPSG', 3826,
     'PROJCS["TWD97 / TM2 zone 121",GEOGCS["TWD97",DATUM["Taiwan_Datum_1997",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",121],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",250000],PARAMETER["false_northing",0],UNIT["metre",1]]',
     'TWD97/TM2 台灣二度分帶')`);
  db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES
    ('WGS 84', 4326, 'EPSG', 4326,
     'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]]',
     'WGS 84 geographic')`);

  // gpkg_contents & gpkg_geometry_columns
  db.run(`CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
    identifier TEXT, description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER)`);
  db.run(`CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL, column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
    z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, column_name))`);

  // metadata table (non-spatial)
  db.run(`CREATE TABLE fit_metadata (
    key TEXT PRIMARY KEY, value TEXT)`);
  const meta = opts.metadata || {};
  for (const [k, v] of Object.entries(meta)) {
    db.run('INSERT INTO fit_metadata VALUES (?,?)', [k, v == null ? '' : String(v)]);
  }

  // boundary_points
  if (opts.points && opts.points.length) {
    db.run(`CREATE TABLE boundary_points (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB,
      point_id TEXT, n REAL, e REAL)`);
    db.run(`INSERT INTO gpkg_contents VALUES
      ('boundary_points','features','boundary_points','套疊後界址點',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       NULL,NULL,NULL,NULL,3826)`);
    db.run(`INSERT INTO gpkg_geometry_columns VALUES
      ('boundary_points','geom','POINT',3826,0,0)`);
    const stmt = db.prepare('INSERT INTO boundary_points (geom,point_id,n,e) VALUES (?,?,?,?)');
    for (const p of opts.points) {
      stmt.run([_wkbPoint(p.x, p.y), p.id || '', p.y, p.x]);
    }
    stmt.free();
  }

  // cadastral_lines (fitted segments)
  if (opts.segments && opts.segments.length) {
    db.run(`CREATE TABLE cadastral_lines (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, line_id INTEGER)`);
    db.run(`INSERT INTO gpkg_contents VALUES
      ('cadastral_lines','features','cadastral_lines','套疊後界址線',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       NULL,NULL,NULL,NULL,3826)`);
    db.run(`INSERT INTO gpkg_geometry_columns VALUES
      ('cadastral_lines','geom','LINESTRING',3826,0,0)`);
    const stmt = db.prepare('INSERT INTO cadastral_lines (geom,line_id) VALUES (?,?)');
    opts.segments.forEach((s, i) => {
      stmt.run([_wkbLine(s[1], s[0], s[3], s[2]), i + 1]);
    });
    stmt.free();
  }

  // adjusted_lines (before/after polygons)
  if (opts.polygons_before || opts.polygons_after) {
    db.run(`CREATE TABLE adjusted_polygons (
      fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, phase TEXT)`);
    db.run(`INSERT INTO gpkg_contents VALUES
      ('adjusted_polygons','features','adjusted_polygons','調整前後輪廓',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       NULL,NULL,NULL,NULL,3826)`);
    db.run(`INSERT INTO gpkg_geometry_columns VALUES
      ('adjusted_polygons','geom','POLYGON',3826,0,0)`);
    const stmt = db.prepare('INSERT INTO adjusted_polygons (geom,phase) VALUES (?,?)');
    if (opts.polygons_before) stmt.run([_wkbPolygon(opts.polygons_before), 'before']);
    if (opts.polygons_after)  stmt.run([_wkbPolygon(opts.polygons_after),  'after']);
    stmt.free();
  }

  _downloadDb(db, opts.filename || 'output.gpkg');
  db.close();
}

/* ── WKB helpers (little-endian) ────────────────────────────────────────── */
function _gpkgHeader(srsId) {
  // GeoPackage Geometry: 2-byte magic + 1 version + 1 flags + 4 srs_id
  const buf  = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint8(0, 0x47); view.setUint8(1, 0x50); // 'GP'
  view.setUint8(2, 0x00);  // version 0
  view.setUint8(3, 0x01);  // flags: little-endian, no envelope
  view.setInt32(4, srsId, true);
  return new Uint8Array(buf);
}

function _wkbPoint(x, y) {
  const body = new ArrayBuffer(21);
  const v    = new DataView(body);
  v.setUint8(0, 1); v.setUint32(1, 1, true);
  v.setFloat64(5, x, true); v.setFloat64(13, y, true);
  return _concat(_gpkgHeader(3826), new Uint8Array(body));
}

function _wkbLine(x1, y1, x2, y2) {
  const body = new ArrayBuffer(1 + 4 + 4 + 16 * 2);
  const v    = new DataView(body);
  v.setUint8(0, 1); v.setUint32(1, 2, true); v.setUint32(5, 2, true);
  v.setFloat64(9,  x1, true); v.setFloat64(17, y1, true);
  v.setFloat64(25, x2, true); v.setFloat64(33, y2, true);
  return _concat(_gpkgHeader(3826), new Uint8Array(body));
}

function _wkbPolygon(coords) {
  // WKB Polygon: [byteOrder][type=3][numRings=1][numPts][x,y,...]
  const n      = coords.length;
  const nClose = n + 1; // close ring
  const body   = new ArrayBuffer(1 + 4 + 4 + 4 + nClose * 16);
  const v      = new DataView(body);
  let off = 0;
  v.setUint8(off++, 1);
  v.setUint32(off, 3, true); off += 4;   // type = Polygon
  v.setUint32(off, 1, true); off += 4;   // numRings
  v.setUint32(off, nClose, true); off += 4; // numPoints in ring
  for (let i = 0; i < n; i++) {
    v.setFloat64(off, coords[i][1], true); off += 8; // x = easting
    v.setFloat64(off, coords[i][0], true); off += 8; // y = northing
  }
  // close ring
  v.setFloat64(off, coords[0][1], true); off += 8;
  v.setFloat64(off, coords[0][0], true);
  return _concat(_gpkgHeader(3826), new Uint8Array(body));
}

function _concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function _downloadDb(db, filename) {
  const data = db.export();
  const blob = new Blob([data], { type: 'application/geopackage+sqlite3' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
