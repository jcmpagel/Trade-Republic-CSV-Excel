/* ===================== Download Functions ===================== */
function blob(data, fn, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fn;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function csvDL(rows, name) {
  const cols = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
  let csv = cols.join(';') + '\n'; // German CSV with semicolon
  rows.forEach((r) => {
    csv +=
      cols
        .map((k) => {
          const v = r[k] || '';
          return v.includes(';') ? `"${v}"` : v;
        })
        .join(';') + '\n';
  });
  blob(csv, name + '.csv', 'text/csv;charset=utf-8');
}

function jsonDL(rows, name) {
  const sanitized = rows.map(r => {
    const entry = {};
    Object.keys(r).forEach(k => {
      if (!k.startsWith('_')) entry[k] = r[k];
    });
    return entry;
  });
  blob(JSON.stringify(sanitized, null, 2), name + '.json', 'application/json');
}

function xlsxDL(rows, name) {
  ensureXLSX(() => {
    /* ----- Prepare data ----- */
    const out = rows.map((r) => {
      const o = {};
      Object.keys(r).forEach(k => {
        if (!k.startsWith('_')) {
          o[k] = r[k];
        }
      });
      
      // Date → real Date object
      const dateValue = o.date || o.datum;
      if (dateValue) {
        const m = dateValue.match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})/);
        if (m) {
          const d = new Date(+m[3], month[strip(m[2])] || 0, +m[1]);
          const key = o.date ? 'date' : 'datum';
          o[key] = { v: d, t: 'd', z: 'dd.mm.yyyy' };
        }
      }
      
      // Format money values
      moneyKeys.forEach((k) => {
        if (o[k]) {
          const num = parseFloat(o[k].replace(/\./g, '').replace(/,/, '.'));
          if (!isNaN(num)) o[k] = { v: num, t: 'n', z: '#,##0.00 "€"' };
        }
      });
      
      // Quantity as number without currency
      const hasQuantity = Object.prototype.hasOwnProperty.call(o, 'quantity');
      const hasStueck = Object.prototype.hasOwnProperty.call(o, 'stueck');
      const quantityValue = hasQuantity ? o.quantity : hasStueck ? o.stueck : null;
      if (quantityValue != null && quantityValue !== '') {
        const q = parseFloat(String(quantityValue).replace(/\./g, '').replace(/,/, '.'));
        if (!isNaN(q)) {
          if (hasQuantity) o.quantity = { v: q, t: 'n', z: '0.00' };
          if (hasStueck) o.stueck = { v: q, t: 'n', z: '0.00' };
        }
      }
      
      return o;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(out, { cellDates: true });
    XLSX.utils.book_append_sheet(wb, ws, 'Daten');
    XLSX.writeFile(wb, name + '.xlsx');
  });
}

function ensureXLSX(cb) {
  if (window.XLSX) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdn.sheetjs.com/xlsx-0.19.3/package/dist/xlsx.full.min.js';
  s.onload = cb;
  document.head.appendChild(s);
} 
