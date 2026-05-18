/**
 * GeoPackage writer using sql.js (SQLite WASM).
 * Produces valid .gpkg with EPSG:3826 (TWD97/TM2) spatial reference.
 *
 * Phase 4 implementation — loaded lazily to avoid blocking startup.
 */

let SQL = null;

async function getSql() {
  if (SQL) return SQL;
  const initSqlJs = (await import('https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-asm.js')).default;
  SQL = await initSqlJs({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${f}`,
  });
  return SQL;
}

export async function writeFitGPKG(fitResult, kcData, caseNo) {
  const sql = await getSql();
  const db = new sql.Database();

  _createGpkgSchema(db);
  _insertSrs(db);

  // Register geometry columns
  _addGeomColumn(db, 'boundary_points', 'geom', 'POINT', 3826);
  _addGeomColumn(db, 'cadastral_lines', 'geom', 'LINESTRING', 3826);

  // boundary_points table
  db.run(`CREATE TABLE IF NOT EXISTS boundary_points (
    fid INTEGER PRIMARY KEY AUTOINCREMENT,
    geom BLOB,
    point_id TEXT,
    n REAL, e REAL,
    type TEXT,
    case_no TEXT
  )`);

  // Insert fitted points
  const stmt = db.prepare(
    `INSERT INTO boundary_points (geom, point_id, n, e, type, case_no) VALUES (?,?,?,?,?,?)`
  );
  for (const p of fitResult.fittedPoints || []) {
    stmt.run([_wkbPoint(p.e, p.n), p.id, p.n, p.e, 'fitted', caseNo]);
  }
  stmt.free();

  // fit_metadata table (non-spatial)
  db.run(`CREATE TABLE IF NOT EXISTS fit_metadata (
    fid INTEGER PRIMARY KEY AUTOINCREMENT,
    case_no TEXT,
    run_date TEXT,
    theta_deg REAL,
    tx REAL,
    ty REAL,
    rmse_before REAL,
    rmse_after REAL
  )`);
  db.run(
    `INSERT INTO fit_metadata VALUES (NULL,?,?,?,?,?,?,?)`,
    [
      caseNo,
      new Date().toISOString(),
      fitResult.theta ?? 0,
      fitResult.tx ?? 0,
      fitResult.ty ?? 0,
      fitResult.rmseBefore ?? 0,
      fitResult.rmseAfter ?? 0,
    ]
  );

  _downloadDb(db, `${caseNo}_fit.gpkg`);
  db.close();
}

export async function writeAdjustGPKG(adjustResult) {
  const sql = await getSql();
  const db = new sql.Database();

  _createGpkgSchema(db);
  _insertSrs(db);
  _addGeomColumn(db, 'adjusted_lines', 'geom', 'LINESTRING', 3826);
  _addGeomColumn(db, 'tolerance_check', 'geom', 'LINESTRING', 3826);

  db.run(`CREATE TABLE IF NOT EXISTS adjusted_lines (
    fid INTEGER PRIMARY KEY AUTOINCREMENT,
    geom BLOB,
    line_id TEXT,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tolerance_check (
    fid INTEGER PRIMARY KEY AUTOINCREMENT,
    geom BLOB,
    line_id TEXT,
    error_before REAL,
    error_after REAL
  )`);

  _downloadDb(db, `adjust_result.gpkg`);
  db.close();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _createGpkgSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL,
    description TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY,
    data_type TEXT NOT NULL,
    identifier TEXT,
    description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x REAL, min_y REAL, max_x REAL, max_y REAL,
    srs_id INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL,
    z TINYINT NOT NULL DEFAULT 0,
    m TINYINT NOT NULL DEFAULT 0,
    CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name)
  )`);

  // Required application_id for GeoPackage
  db.run(`PRAGMA application_id = 0x47504B47`); // GPKG
  db.run(`PRAGMA user_version = 10300`);
}

function _insertSrs(db) {
  db.run(`INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES (
    'WGS 84 geodetic', 4326, 'EPSG', 4326,
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]]',
    'WGS 84'
  )`);
  db.run(`INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES (
    'TWD97 / TM2 zone 121', 3826, 'EPSG', 3826,
    'PROJCS["TWD97 / TM2 zone 121",GEOGCS["TWD97",DATUM["Taiwan_Datum_1997",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.017453292519943278]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",121],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",250000],PARAMETER["false_northing",0],UNIT["metre",1]]',
    'TWD97/TM2'
  )`);
}

function _addGeomColumn(db, table, column, geomType, srsId) {
  db.run(`INSERT OR IGNORE INTO gpkg_geometry_columns VALUES (?,?,?,?,0,0)`,
    [table, column, geomType, srsId]);
  db.run(`INSERT OR IGNORE INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES (?,?,?,?)`,
    [table, 'features', table, srsId]);
}

function _wkbPoint(x, y) {
  // GeoPackage geometry blob: 2-byte magic + flags + srs_id(4) + envelope? + WKB
  const buf = new ArrayBuffer(2 + 1 + 1 + 4 + 1 + 4 + 8 + 8);
  const view = new DataView(buf);
  view.setUint8(0, 0x47); // G
  view.setUint8(1, 0x50); // P
  view.setUint8(2, 0x00); // version
  view.setUint8(3, 0x01); // flags: little-endian, no envelope
  view.setInt32(4, 3826, true); // srs_id
  // WKB Point (little-endian)
  view.setUint8(8, 1); // byte order LE
  view.setUint32(9, 1, true); // WKB type = Point
  view.setFloat64(13, x, true);
  view.setFloat64(21, y, true);
  return new Uint8Array(buf);
}

function _downloadDb(db, filename) {
  const data = db.export();
  const blob = new Blob([data], { type: 'application/geopackage+sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
