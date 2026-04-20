// Minimal CSV parser/writer. Handles quoted fields with commas and escaped quotes.

export function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { cur.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue;
    }
    field += c; i++;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}

export function toCSV(rows) {
  return rows.map(r => r.map(cell => {
    const s = String(cell ?? '');
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',')).join('\n');
}

// Convert a parsed CSV (with header row) to inventory objects.
// Accepts columns in any order; tolerant about names: width/w, length/l/len,
// qty/quantity/count, name/id/label.
export function rowsToInventory(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = (names) => header.findIndex(h => names.includes(h));
  const iW = idx(['width', 'w', 'plank_width', 'board_width']);
  const iL = idx(['length', 'l', 'len', 'plank_length', 'board_length']);
  const iQ = idx(['qty', 'quantity', 'count', 'n']);
  const iN = idx(['name', 'id', 'label', 'sku']);
  // If no recognized header, assume columns are width,length,qty,name.
  const hasHeader = iW >= 0 || iL >= 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const out = [];
  let autoN = 1;
  for (const r of dataRows) {
    const width = Number(hasHeader ? r[iW] : r[0]);
    const length = Number(hasHeader ? r[iL] : r[1]);
    if (!isFinite(width) || width <= 0 || !isFinite(length) || length <= 0) continue;
    const qty = Number(hasHeader ? (iQ >= 0 ? r[iQ] : 1) : (r[2] ?? 1));
    const name = String((hasHeader ? (iN >= 0 ? r[iN] : '') : r[3]) || `B${autoN++}`).trim();
    out.push({
      name,
      width,
      length,
      qty: isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
    });
  }
  return out;
}
