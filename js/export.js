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

const NOTION_NUMERIC_COLUMNS = new Set([
  'zahlungseingang', 'zahlungsausgang', 'saldo',
  'stueck', 'kurs', 'betrag',
  'quantity', 'pricePerUnit', 'marketValueEUR',
  'incoming', 'outgoing', 'balance', 'amount', 'price',
  'gekauft-€', 'verkauft-€', 'cost-basis-€', 'realisiert-€',
  'aktueller-wert-€', 'unrealisiert-€', 'gesamt-pnl-€',
  'trades'
]);

const NOTION_DATE_COLUMNS = new Set(['datum', 'date', 'priceDate', 'erster-trade', 'letzter-trade']);

const NOTION_MONTH_MAP = {
  jan: '01', januar: '01', january: '01', gen: '01', gennaio: '01',
  feb: '02', februar: '02', february: '02', febb: '02', febbraio: '02',
  mar: '03', mär: '03', maerz: '03', marz: '03', märz: '03', march: '03', marzo: '03',
  apr: '04', april: '04', aprile: '04',
  mai: '05', may: '05', mag: '05', maggio: '05',
  jun: '06', juni: '06', june: '06', giu: '06', giugno: '06',
  jul: '07', juli: '07', july: '07', lug: '07', luglio: '07',
  aug: '08', august: '08', ago: '08', agosto: '08',
  sep: '09', sept: '09', september: '09', set: '09', sett: '09', settembre: '09',
  okt: '10', oktober: '10', oct: '10', october: '10', ott: '10', ottobre: '10',
  nov: '11', november: '11',
  dez: '12', dezember: '12', dec: '12', december: '12', dic: '12', dicembre: '12'
};

function notionPad2(value) {
  return String(value).padStart(2, '0');
}

function toNotionNumericValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';

  const text = String(value).trim();
  if (!text) return '';

  const sanitized = text
    .replace(/€/g, '')
    .replace(/\u00A0/g, '')
    .replace(/\s/g, '');

  let normalized = sanitized;
  const hasComma = sanitized.includes(',');
  const hasDot = sanitized.includes('.');

  if (hasComma && hasDot && sanitized.lastIndexOf(',') > sanitized.lastIndexOf('.')) {
    normalized = sanitized.replace(/\./g, '').replace(/,/g, '.');
  } else if (hasComma && hasDot) {
    normalized = sanitized.replace(/,/g, '');
  } else if (hasComma) {
    normalized = sanitized.replace(/,/g, '.');
  }

  const numeric = parseFloat(normalized);
  if (!Number.isFinite(numeric)) return text.replace(/€/g, '').replace(/,/g, '.').trim();
  return String(numeric);
}

function toNotionIsoDate(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';

  let m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return text;

  m = text.match(/^(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})$/i);
  if (m) {
    const day = notionPad2(m[1]);
    const monthKey = m[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const monthValue = NOTION_MONTH_MAP[monthKey];
    if (monthValue) return `${m[3]}-${monthValue}-${day}`;
  }

  return text;
}

function notionCsvDL(rows, name) {
  const cols = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
  let csv = cols.join(';') + '\n';

  rows.forEach((r) => {
    csv +=
      cols
        .map((k) => {
          let raw = r[k] || '';
          if (NOTION_NUMERIC_COLUMNS.has(k)) raw = toNotionNumericValue(r[k]);
          else if (NOTION_DATE_COLUMNS.has(k)) raw = toNotionIsoDate(r[k]);

          const v = String(raw);
          return v.includes(';') ? `"${v}"` : v;
        })
        .join(';') + '\n';
  });

  blob(csv, `${name}-notion.csv`, 'text/csv;charset=utf-8');
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
      const dateValue = o.date || o.datum || o.priceDate;
      if (dateValue) {
        // Try German date format first (DD.MM.YYYY)
        const germanMatch = dateValue.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (germanMatch) {
          const d = new Date(+germanMatch[3], +germanMatch[2] - 1, +germanMatch[1]);
          const key = o.date ? 'date' : (o.datum ? 'datum' : 'priceDate');
          o[key] = { v: d, t: 'd', z: 'dd.mm.yyyy' };
        } else {
          // Try other date formats (DD Month YYYY)
          const m = dateValue.match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})/);
          if (m) {
            const d = new Date(+m[3], month[strip(m[2])] || 0, +m[1]);
            const key = o.date ? 'date' : (o.datum ? 'datum' : 'priceDate');
            o[key] = { v: d, t: 'd', z: 'dd.mm.yyyy' };
          }
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
      
      // Handle pricePerUnit if it's a string (portfolio data)
      if (o.pricePerUnit && typeof o.pricePerUnit === 'string') {
        const num = parseFloat(o.pricePerUnit.replace(/\./g, '').replace(/,/, '.'));
        if (!isNaN(num)) o.pricePerUnit = { v: num, t: 'n', z: '#,##0.00 "€"' };
      }
      
      // Handle marketValueEUR if it's a string (portfolio data)
      if (o.marketValueEUR && typeof o.marketValueEUR === 'string') {
        const num = parseFloat(o.marketValueEUR.replace(/\./g, '').replace(/,/, '.'));
        if (!isNaN(num)) o.marketValueEUR = { v: num, t: 'n', z: '#,##0.00 "€"' };
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
