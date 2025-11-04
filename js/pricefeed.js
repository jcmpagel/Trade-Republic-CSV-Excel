// Lightweight price feed + estimation helpers (no keys required for Yahoo).
// Notes:
// - Yahoo endpoint returns chart JSON with timestamps and quote arrays.
// - Onvista endpoint requires ids; we keep a generic parser and allow custom url.

(function() {
  // Resolve proxy base from UI or localStorage (same input used for OpenFIGI)
  function getProxyBase() {
    try {
      const el = typeof document !== 'undefined' && document.getElementById('openfigi-proxy');
      const v = (el && el.value && el.value.trim()) || (typeof localStorage !== 'undefined' && localStorage.getItem('openfigiProxy')) || '';
      if (!v) return '';
      // normalize: ensure trailing slash trimmed
      return String(v).replace(/\/$/, '');
    } catch { return ''; }
  }

  const YAHOO_URL = (symbol, range='1y', interval='1d') => {
    const base = getProxyBase();
    if (base) {
      // Use Worker proxy to bypass CORS: GET {base}/yahoo/chart?symbol=...&range=...&interval=...
      const params = new URLSearchParams({ symbol, range, interval });
      return `${base}/yahoo/chart?${params.toString()}`;
    }
    // Fallback: direct Yahoo (will be blocked by CORS in browsers)
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  };

  async function fetchYahooDaily(symbol, range='1y') {
    const url = YAHOO_URL(symbol, range, '1d');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error('Yahoo: no result');
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      out.push({
        date: new Date(ts[i] * 1000),
        open: q.open?.[i] ?? null,
        high: q.high?.[i] ?? null,
        low: q.low?.[i] ?? null,
        close: q.close?.[i] ?? null,
        volume: q.volume?.[i] ?? null,
      });
    }
    return out;
  }

  // Onvista: expects a full URL; returns arrays with last/high/low and datetimeLast (unix)
  async function fetchOnvista(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Onvista HTTP ${res.status}`);
    const json = await res.json();
    const ts = json.datetimeLast || [];
    const last = json.last || [];
    const high = json.high || [];
    const low = json.low || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      out.push({
        date: new Date(ts[i] * 1000),
        close: last[i] ?? null,
        high: high[i] ?? null,
        low: low[i] ?? null
      });
    }
    return out;
  }

  // Quote validation via proxy: returns a map of symbol -> quote object
  async function fetchYahooQuote(symbols) {
    if (!symbols || symbols.length === 0) return new Map();
    const base = getProxyBase();
    if (!base) {
      // Without proxy we skip validation to avoid CORS
      const m = new Map();
      symbols.forEach(s => m.set(s, null));
      return m;
    }
    const url = `${base}/yahoo/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yahoo Quote HTTP ${res.status}`);
    const json = await res.json();
    const list = json?.quoteResponse?.result || [];
    const map = new Map();
    // Initialize as null
    symbols.forEach(s => map.set(s, null));
    list.forEach(q => { if (q && q.symbol) map.set(String(q.symbol), q); });
    return map;
  }

  // Returns Set of valid symbols and details map
  async function validateYahooSymbols(symbols) {
    const quotes = await fetchYahooQuote(symbols);
    const valid = new Set();
    const details = new Map();
    for (const s of symbols) {
      const q = quotes.get(s) || null;
      if (q) { valid.add(s); details.set(s, q); }
    }
    return { valid, details };
  }

  const COMMON_SUFFIXES = ['.DE', '.AS', '.PA', '.MI', '.L', '.SW', '.HK', ''];
  function deriveAltSymbols(symbol) {
    const out = new Set();
    const s = String(symbol || '').toUpperCase();
    out.add(s);
    if (!s.includes('.')) {
      // Strip common currency endings and punctuation
      const base = s.replace(/(EUR|USD|GBP)$/i, '').replace(/[-_\s]+/g, '');
      if (base && base !== s) out.add(base);
      // Try base with common exchange suffixes
      for (const suf of COMMON_SUFFIXES) {
        if (base) out.add(base + suf);
        out.add(s + suf);
      }
    }
    return [...out];
  }

  async function resolveYahooSymbol(symbol) {
    try {
      const candidates = deriveAltSymbols(symbol).slice(0, 12);
      const { valid } = await validateYahooSymbols(candidates);
      const first = candidates.find(c => valid.has(c));
      return first || null;
    } catch (e) {
      // If quote validation is unavailable (e.g., 401), give up gracefully
      return null;
    }
  }

  // Very light symbol mapping for common ISINs (extend as needed)
  const ISIN_TO_YAHOO = new Map([
    // Example ETFs/stocks; users can edit mapping UI
    ['US0378331005', 'AAPL'],
    ['US5949181045', 'MSFT'],
    ['US88160R1014', 'TSLA'],
    ['US02079K3059', 'GOOGL'],
  ]);

  function dateKeyFromGerman(dateStr) {
    // Accepts formats like "03 März 2025" or "03 Feb. 2025"
    const m = dateStr && dateStr.match(/(\d{1,2})\s+([^\s.]+)\.??\s+(\d{4})/);
    if (!m) return null;
    const months = { 'Januar':0,'Jan.':0,'Februar':1,'Feb.':1,'März':2,'Mär.':2,'Mrz':2,'April':3,'Apr.':3,'Mai':4,'Juni':5,'Jun.':5,'Juli':6,'Jul.':6,'August':7,'Aug.':7,'September':8,'Sep.':8,'Sept.':8,'Oktober':9,'Okt.':9,'November':10,'Nov.':10,'Dezember':11,'Dez.':11 };
    const d = parseInt(m[1], 10), mon = months[m[2]] ?? 0, y = parseInt(m[3], 10);
    const dt = new Date(y, mon, d);
    return dt.toISOString().slice(0,10);
  }

  // Estimate quantity per row with missing quantity: qty ≈ |cashFlow| / closePrice
  function estimateQuantities(trades, priceSeriesBySymbol, mapping) {
    const estimated = [];
    for (const t of trades) {
      const isin = t.isin || '';
      const symbol = mapping.get(isin) || ISIN_TO_YAHOO.get(isin);
      const dk = dateKeyFromGerman(t.date || t.datum || '');
      let qty = t.quantity || '';
      let priceUsed = null;

      if (!qty && symbol && dk && priceSeriesBySymbol.has(symbol)) {
        const series = priceSeriesBySymbol.get(symbol);
        // find closest date (same day match preferred)
        const idx = series.findIndex(p => p.date.toISOString().slice(0,10) === dk);
        const p = idx >= 0 ? series[idx] : null;
        const close = p?.close;
        // use outgoing for buys, incoming for sells
        const euro = (t.outgoing && t.outgoing.includes('€')) ? t.outgoing : (t.incoming || '');
        const cash = parseFloat(String(euro).replace(/€/g,'').replace(/\./g,'').replace(/,/g,'.')) || 0;
        if (close && cash) {
          priceUsed = close;
          qty = Math.abs(cash / close).toFixed(6);
        }
      }

      estimated.push({ ...t, quantity: qty, priceUsed, symbol });
    }
    return estimated;
  }

  async function buildMappingUI(trades, container) {
    container.innerHTML = '';
    const uniqueISIN = [...new Set(trades.map(t => t.isin).filter(Boolean))];
    if (uniqueISIN.length === 0) {
      container.innerHTML = '<p class="text-sm text-slate-600">Keine ISINs erkannt.</p>';
      return { mapping: new Map(), inputs: new Map() };
    }
    const map = new Map();
    const inputs = new Map();
    const grid = document.createElement('div');
    grid.className = 'grid gap-3 md:grid-cols-2';
    uniqueISIN.forEach(isin => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3';
      const label = document.createElement('div');
      label.className = 'text-xs text-slate-600 break-all';
      label.textContent = `ISIN: ${isin}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = ISIN_TO_YAHOO.get(isin) || 'Symbol (z.B. AAPL)';
      input.className = 'flex-1 rounded-md border-slate-300';
      input.dataset.isin = isin;
      input.value = ISIN_TO_YAHOO.get(isin) || '';
      input.addEventListener('input', () => { if (input.value) map.set(isin, input.value.trim()); else map.delete(isin); });
      row.append(label, input);
      grid.appendChild(row);
      if (ISIN_TO_YAHOO.has(isin)) map.set(isin, ISIN_TO_YAHOO.get(isin));
      inputs.set(isin, input);
    });
    container.appendChild(grid);
    return { mapping: map, inputs };
  }

  function renderEstimationCharts(estimated) {
    if (typeof Chart === 'undefined') return;
    const hasQty = estimated.filter(e => e.quantity && String(e.quantity).trim() !== '').length;
    const missing = estimated.length - hasQty;
    const pieCtx = document.getElementById('qtyPie')?.getContext('2d');
    if (pieCtx) new Chart(pieCtx, { type: 'doughnut', data: { labels: ['mit Menge','ohne Menge'], datasets: [{ data: [hasQty, missing], backgroundColor: ['#10b981','#ef4444'] }] }, options: { plugins: { legend: { position: 'bottom' } } } });

    const byIsin = new Map();
    estimated.forEach(e => {
      if (!e.isin) return;
      const q = parseFloat(e.quantity || '0');
      if (!isFinite(q) || q <= 0) return;
      byIsin.set(e.isin, (byIsin.get(e.isin) || 0) + q);
    });
    const labels = [...byIsin.keys()].slice(0, 12);
    const data = labels.map(l => byIsin.get(l));
    const barCtx = document.getElementById('qtyBar')?.getContext('2d');
    if (barCtx) new Chart(barCtx, { type: 'bar', data: { labels, datasets: [{ label: 'Stückzahl (geschätzt)', data, backgroundColor: '#3b82f6' }] }, options: { responsive: true, plugins: { legend: { display: false } } } });
  }

  async function renderPerTickerCharts(symbols, limit = 12) {
    if (typeof Chart === 'undefined') return;
    const container = document.getElementById('tickerCharts');
    if (!container) return;
    container.innerHTML = '';
    const list = [...new Set(symbols)].slice(0, limit);

    for (const sym of list) {
      try {
        const data = await fetchYahooDaily(sym, '5y');
        if (!data || data.length === 0) continue;
        const wrap = document.createElement('div');
        wrap.className = 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm';
        const title = document.createElement('div');
        title.className = 'text-sm font-semibold text-slate-700 mb-2';
        title.textContent = `${sym} — Schlusskurse (5Y)`;
        const canvas = document.createElement('canvas');
        wrap.append(title, canvas);
        container.appendChild(wrap);

        const labels = data.map(d => d.date.toISOString().slice(0,10));
        const closes = data.map(d => d.close);
        const ctx = canvas.getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: { labels, datasets: [{ label: sym, data: closes, borderColor: '#0ea5e9', borderWidth: 1.5, pointRadius: 0, tension: 0.1 }] },
          options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: false } }, plugins: { legend: { display: false } } }
        });
      } catch (e) {
        // Skip this symbol silently
        console.warn('Chart (5y) failed for', sym, e);
      }
    }
  }

  window.pricefeed = {
    fetchYahooDaily,
    fetchOnvista,
    fetchYahooQuote,
    validateYahooSymbols,
    resolveYahooSymbol,
    buildMappingUI,
    estimateQuantities,
    renderEstimationCharts,
    renderPerTickerCharts,
  };
})();
