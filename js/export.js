/**
 * Export fitted boundary points as TXT for GPS / total station upload.
 * Format: 點號,N,E  (one point per line, comma-separated)
 */
export function exportCoordTXT(points, filename = 'fit_result') {
  if (!points || !points.length) return;

  const header = '點號,N(m),E(m)\n';
  const rows = points.map((p) => `${p.id},${p.n.toFixed(3)},${p.e.toFixed(3)}`).join('\n');
  const content = header + rows;

  downloadText(content, `${filename}_coords.txt`, 'text/plain;charset=utf-8');
}

function downloadText(content, filename, mimeType) {
  const blob = new Blob(['﻿' + content], { type: mimeType }); // BOM for Excel/GPS compatibility
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
