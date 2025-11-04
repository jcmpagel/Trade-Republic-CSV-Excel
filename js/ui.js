/* ===================== UI Components ===================== */

const BUTTON_BASE_CLASSES = 'inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-400 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300 focus:ring-offset-0';
const BUTTON_PRIMARY_CLASSES = 'inline-flex items-center justify-center rounded-md border border-transparent bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2';
const TAB_BASE_CLASSES = 'cursor-pointer rounded-t-md border border-transparent px-4 py-2 text-sm font-medium transition';
const TAB_ACTIVE_CLASSES = 'border-slate-200 border-b-white bg-white text-slate-900';
const TAB_INACTIVE_CLASSES = 'bg-slate-100 text-slate-600 hover:text-slate-900';
const TAB_CONTENT_BASE_CLASSES = 'border-t border-slate-200 p-6';

function applyTabStyles(tabElement, isActive) {
  tabElement.className = `${TAB_BASE_CLASSES} ${isActive ? TAB_ACTIVE_CLASSES : TAB_INACTIVE_CLASSES}`;
  tabElement.dataset.active = isActive ? 'true' : 'false';
}

function applyTabContentStyles(contentElement, isActive) {
  contentElement.className = `${TAB_CONTENT_BASE_CLASSES} ${isActive ? '' : 'hidden'}`;
  contentElement.dataset.active = isActive ? 'true' : 'false';
}
function createTabNavigationWithTrading(configOrCash, mmfComponent, tradingComponent) {
  const isConfigObject = configOrCash && typeof configOrCash === 'object' && !Array.isArray(configOrCash) && !configOrCash.nodeType;
  const {
    cash,
    charts,
    mmf,
    trading,
    support,
    onChartsActivate
  } = isConfigObject
    ? configOrCash
    : { cash: configOrCash, mmf: mmfComponent, trading: tradingComponent };

  const tabDefinitions = [
    { label: 'Cash-Transaktionen', content: cash },
    { label: 'Diagramme', content: charts, onActivate: onChartsActivate },
    { label: 'Geldmarktfonds', content: mmf },
    { label: 'Trading P&L (Beta)', content: trading },
    { label: 'Ergebnisübersicht', content: support }
  ].filter(def => def && def.content);

  if (tabDefinitions.length === 0) return null;

  const container = document.createElement('div');
  container.className = 'mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm';
  container.dataset.tabContainer = 'true';

  const tabs = document.createElement('div');
  tabs.className = 'flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-4 pt-4';
  container.appendChild(tabs);

  const components = [];

  const registerTab = ({ label, content, onActivate }) => {
    const isFirst = components.length === 0;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = label;
    tab.dataset.tabRole = 'navigation';
    tab.dataset.tabLabel = label;
    applyTabStyles(tab, isFirst);
    tabs.appendChild(tab);

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('space-y-6');
    applyTabContentStyles(contentDiv, isFirst);
    contentDiv.dataset.tabRole = 'panel';
    contentDiv.dataset.tabLabel = label;
    contentDiv.appendChild(content);
    container.appendChild(contentDiv);

    const entry = { tab, contentDiv, onActivate, activated: false };
    components.push(entry);

    if (isFirst && onActivate && !entry.activated) {
      entry.activated = true;
      setTimeout(onActivate, 0);
    }

    tab.addEventListener('click', () => {
      components.forEach(comp => {
        const active = comp === entry;
        applyTabStyles(comp.tab, active);
        applyTabContentStyles(comp.contentDiv, active);
      });
      if (entry.onActivate && !entry.activated) {
        entry.activated = true;
        setTimeout(entry.onActivate, 0);
      }
    });
  };

  tabDefinitions.forEach(registerTab);

  return container;
}

function createTabNavigation(cashComponent, mmfComponent) {
  return createTabNavigationWithTrading({ cash: cashComponent, mmf: mmfComponent });
}

function renderTradingComponent(tradingData, tradingTransactions) {
  const container = document.createElement('div');
  container.className = 'space-y-6';

  const betaNotice = document.createElement('div');
  betaNotice.className = 'flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900';
  betaNotice.innerHTML = `
    <div class="shrink-0 pt-[2px]">
      <span class="inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700">Beta</span>
    </div>
    <p class="leading-relaxed">Die Trading P&L Analyse befindet sich aktuell in der Beta-Phase. Ergebnisse können unvollständig sein – Feedback ist herzlich willkommen!</p>
  `;
  container.appendChild(betaNotice);

  const enrichedData = window.currentSecuritiesData ?
    enrichTradingDataWithSecurities(tradingData, window.currentSecuritiesData) :
    tradingData;

  if (!window.currentSecuritiesData) {
    const securitiesSection = document.createElement('div');
    securitiesSection.className = 'rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-700 space-y-3';
    securitiesSection.innerHTML = `
      <p class="flex items-center gap-2 text-sm font-medium text-slate-800">
        <i data-feather="info"></i>
        Optional: Lade dein aktuelles Depot-PDF hoch für aktuelle Portfolio-Werte und unrealisierte Gewinne/Verluste.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <input type="file" id="securities-pdf-input" accept=".pdf" class="hidden">
        <button type="button" class="${BUTTON_BASE_CLASSES} gap-2" onclick="document.getElementById('securities-pdf-input').click()">
          <i data-feather="upload"></i>
          Depot-PDF hochladen
        </button>
        <span class="text-sm text-slate-600" id="securities-upload-status"></span>
      </div>
    `;
    container.appendChild(securitiesSection);

    setTimeout(() => {
      const fileInput = document.getElementById('securities-pdf-input');
      if (fileInput) {
        fileInput.addEventListener('change', handleSecuritiesPdfUpload);
      }
    }, 100);
  } else {
    const securitiesStatus = document.createElement('div');
    securitiesStatus.className = 'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900';
    securitiesStatus.innerHTML = `
      <span class="flex items-center gap-2">
        <i data-feather="check-circle"></i>
        Portfolio-Daten geladen (Stand ${enrichedData.securitiesDate || 'unbekannt'})
      </span>
      <button type="button" class="${BUTTON_BASE_CLASSES} gap-2" onclick="clearSecuritiesData()">
        <i data-feather="x"></i>
        Depot-Daten entfernen
      </button>
    `;
    container.appendChild(securitiesStatus);
  }

  const statsEl = document.createElement('div');
  statsEl.innerHTML = createEnhancedTradingStatsSummary(enrichedData);
  container.appendChild(statsEl);

  container.appendChild(createTradingCharts(enrichedData, tradingTransactions));

  container.appendChild(buttonBar(enrichedData.pnlSummary, 'trading-pnl'));

  const explanationEl = document.createElement('div');
  explanationEl.className = 'space-y-4';
  explanationEl.innerHTML = `
    <div class="rounded-lg border border-slate-200 bg-slate-50 p-5 space-y-3 text-sm text-slate-700">
      <h4 class="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <i data-feather="info"></i>
        So interpretierst du deine Trading-Daten:
      </h4>
      <ul class="space-y-1 list-disc pl-5">
        <li><strong>Offene Positionen:</strong> Aktien, die du noch besitzt (Geld ist investiert)</li>
        <li><strong>Geschlossene Positionen:</strong> Aktien, die du komplett verkauft hast</li>
        <li><strong>Realisierte Gewinne:</strong> Tatsächliche Gewinne/Verluste aus Verkäufen</li>
        ${window.currentSecuritiesData ? '<li><strong>Unrealisierte Gewinne:</strong> Potenzielle Gewinne/Verluste basierend auf aktuellen Kursen</li>' : ''}
        <li><strong>Cost Basis:</strong> Wieviel Geld noch in der Aktie steckt</li>
        ${!window.currentSecuritiesData ? '<li><em>Hinweis: Für unrealisierte P&L benötigen wir aktuelle Kursdaten (Depot-PDF hochladen)</em></li>' : ''}
      </ul>
    </div>
  `;
  container.appendChild(explanationEl);

  if (enrichedData && enrichedData.pnlSummary.length > 0) {
    const tableData = enrichedData.pnlSummary.map(pos => {
      const baseData = {
        aktie: pos.stockName,
        isin: pos.isin,
        'gekauft-€': pos.totalBought.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }),
        'verkauft-€': pos.totalSold.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }),
        'cost-basis-€': pos.costBasis.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }),
        'realisiert-€': pos.realizedGainLoss.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
      };

      if (window.currentSecuritiesData && pos.hasCurrentData) {
        baseData['aktueller-wert-€'] = pos.currentValue.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
        baseData['unrealisiert-€'] = (pos.unrealizedPnL || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
        baseData['gesamt-pnl-€'] = (pos.totalPnL || pos.realizedGainLoss).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
      }

      baseData.status = pos.statusIcon;
      baseData.trades = pos.totalTransactions;
      baseData['erster-trade'] = pos.firstTrade;
      baseData['letzter-trade'] = pos.lastTrade;

      return baseData;
    });

    const tradingTable = makeTable('Trading Details', tableData);
    container.appendChild(tradingTable);
  }

  setTimeout(() => {
    if (typeof feather !== 'undefined') {
      feather.replace();
    }
  }, 100);

  return container;
}

function renderComponent(title, rows, prefix, options = {}) {
  const container = document.createElement('div');
  container.className = 'space-y-4';
  container.appendChild(buttonBar(rows, prefix));
  
  // Simplified statistics for this table
  const detailStats = document.createElement('div');
  detailStats.className = 'text-sm text-slate-600';
  
  let statsText = `<strong class="font-semibold text-slate-900">${rows.length} Transaktionen gefunden.</strong>`;
  if (typeof options.failedChecks === 'number') {
    if (options.failedChecks > 0) {
      statsText += ` <span class="text-red-600">(${options.failedChecks} Sanity-Check-Fehler)</span>`;
    } else if (rows.length > 0) {
      statsText += ' <span class="text-emerald-600">(alle Berechnungen konsistent)</span>';
    }
  }
  
  detailStats.innerHTML = statsText;
  container.appendChild(detailStats);

  // Add table
  container.appendChild(makeTable(title, rows));
  return container;
}

function renderSupportComponent({ cashCount = 0, mmfCount = 0, tradingCount = 0, failedChecks = 0 } = {}) {
  const container = document.createElement('div');
  container.className = 'space-y-6';

  const summary = document.createElement('div');
  summary.className = 'rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-700';
  const total = cashCount + mmfCount + tradingCount;
  summary.innerHTML = `
    <h3 class="text-base font-semibold text-slate-900">Analyse abgeschlossen</h3>
    <p class="mt-2 leading-relaxed">Es wurden <strong>${total}</strong> Datensätze erkannt${
      failedChecks > 0
        ? ` – bitte prüfe <strong>${failedChecks}</strong> markierte Salden in den Tabellen.`
        : '.'
    } Du kannst die Daten jederzeit erneut exportieren oder weitere PDFs verarbeiten.</p>
  `;
  container.appendChild(summary);

  const info = document.createElement('div');
  info.className = 'rounded-xl border border-dashed border-slate-200 bg-white p-6 text-sm text-slate-700';
  info.innerHTML = `
    <p>Diese Open-Source-Version enthält ausschließlich die Kernfunktionen zum Hochladen, Analysieren und Exportieren deiner Kontoauszüge. Alle Verarbeitungsschritte laufen lokal in deinem Browser.</p>
    <p class="mt-2">Forke das Projekt, passe es an eigene Workflows an oder erweitere die Exportformate nach Bedarf.</p>
  `;
  container.appendChild(info);

  return container;
}

function makeTable(title, rows) {
  const cols = Object.keys(rows[0]).filter(k => !k.startsWith('_'));
  const wrapper = document.createElement('div');
  wrapper.className = 'overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm';

  const table = document.createElement('table');
  table.className = 'min-w-full table-auto text-left text-sm text-slate-700';
  const thead = document.createElement('thead');
  thead.className = 'bg-slate-50 text-xs uppercase tracking-wide text-slate-600';
  const headRow = document.createElement('tr');
  
  cols.forEach((k) => {
    const th = document.createElement('th');
    th.className = 'px-4 py-3 text-left font-semibold';
    th.textContent = k.charAt(0).toUpperCase() + k.slice(1);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbody.className = 'divide-y divide-slate-100';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const hasSanityIssue = r._sanityCheckOk === false;
    const baseRowClasses = 'odd:bg-white even:bg-slate-50 hover:bg-slate-50';
    tr.className = hasSanityIssue ? `${baseRowClasses} sanity-check-failed` : baseRowClasses;
    if (hasSanityIssue) {
      tr.title = 'Abweichung im Saldo erkannt';
    }
    cols.forEach((k) => {
      const td = document.createElement('td');
      td.className = 'px-4 py-3 align-top break-words';
      td.textContent = r[k];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function buttonBar(rows, name) {
  const bar = document.createElement('div');
  bar.className = 'flex flex-wrap items-center gap-3';
  
  const mkBtn = (txt, cb) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = txt === 'CSV' ? `${BUTTON_PRIMARY_CLASSES}` : BUTTON_BASE_CLASSES;
    b.textContent = txt;
    b.onclick = cb;
    bar.appendChild(b);
  };
  
  mkBtn('CSV', () => csvDL(rows, name));
  mkBtn('Excel', () => xlsxDL(rows, name));
  mkBtn('JSON', () => jsonDL(rows, name));
  return bar;
} 
