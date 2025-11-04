/* ===================== Helpers ===================== */
const RUN_BUTTON_BASE_CLASSES = [
  'border-slate-300',
  'bg-white',
  'text-slate-700',
  'hover:border-slate-400',
  'hover:text-slate-900',
  'focus:ring-slate-300'
];

const RUN_BUTTON_SUCCESS_CLASSES = [
  'border-transparent',
  'bg-emerald-600',
  'text-white',
  'hover:bg-emerald-500',
  'focus:ring-emerald-400'
];

function applyRunButtonBase(disable = false) {
  const runBtn = $('run');
  if (!runBtn) return;
  RUN_BUTTON_SUCCESS_CLASSES.forEach(cls => runBtn.classList.remove(cls));
  RUN_BUTTON_BASE_CLASSES.forEach(cls => runBtn.classList.add(cls));
  runBtn.classList.remove('cursor-wait', 'opacity-70');
  runBtn.disabled = disable;
}

function applyRunButtonProcessing() {
  const runBtn = $('run');
  if (!runBtn) return;
  RUN_BUTTON_SUCCESS_CLASSES.forEach(cls => runBtn.classList.remove(cls));
  RUN_BUTTON_BASE_CLASSES.forEach(cls => runBtn.classList.add(cls));
  runBtn.disabled = true;
  runBtn.classList.add('cursor-wait', 'opacity-70');
}

function applyRunButtonSuccess() {
  const runBtn = $('run');
  if (!runBtn) return;
  RUN_BUTTON_BASE_CLASSES.forEach(cls => runBtn.classList.remove(cls));
  RUN_BUTTON_SUCCESS_CLASSES.forEach(cls => runBtn.classList.add(cls));
  runBtn.classList.remove('cursor-wait', 'opacity-70');
  runBtn.disabled = false;
}

function scrollToResultsSummary() {
  const summaryEl = document.getElementById('results-summary');
  if (summaryEl) {
    const header = document.querySelector('header');
    const offset = header ? header.offsetHeight + 16 : 0;
    const top = summaryEl.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

/* ===================== File Handling ===================== */
const processFile = (file) => {
  if (!file) {
    applyRunButtonBase(true);
    return;
  }
  applyRunButtonBase(true);
  $("status").textContent = "PDF wird geladen …";
  const reader = new FileReader();
  reader.onload = (ev) => {
    pdfjsLib.getDocument(new Uint8Array(ev.target.result)).promise
      .then((doc) => {
        pdf = doc;
        applyRunButtonBase(false);
        $("status").textContent = `${doc.numPages} Seiten geladen`;
        runAnalysis();
      })
      .catch(err => {
        $("status").textContent = "Fehler: " + err.message;
        applyRunButtonBase(true);
      });
  };
  reader.readAsArrayBuffer(file);
};

$("file").onchange = (e) => processFile(e.target.files[0]);

/* ===================== Main Processing Function ===================== */
async function runAnalysis() {
  if (!pdf) return;
  applyRunButtonProcessing();
  $("status").textContent = "Analysiere PDF …";
  const debugEl = $("debug");
  if (debugEl) {
    debugEl.innerHTML = "";
  }

  try {
    const parseOptions = {
      updateStatus: (message) => {
        if (message) {
          $("status").textContent = message;
        }
      },
      updateProgress: (value, total) => {
        if (!total || total <= 0) return;
        const percent = Math.min(100, Math.round((value / total) * 100));
        $("status").textContent = `Verarbeite Seite ${value}/${total} (${percent}%)`;
      },
    };

    const results = await parsePDF(pdf, parseOptions);

    const { transactions: cashTransactionsWithSanity, failedChecks } = computeCashSanityChecks(results.cash || []);

    const cashDisplay = cashTransactionsWithSanity.map((t) => ({ ...t }));
    const cashForAnalytics = cashTransactionsWithSanity.map((t) => ({
      date: t.datum,
      type: t.typ,
      description: t.beschreibung,
      incoming: t.zahlungseingang,
      outgoing: t.zahlungsausgang,
      balance: t.saldo,
    }));

    const interestDisplay = (results.interest || []).map((t) => ({ ...t }));
    const interestForAnalytics = interestDisplay.map((t) => ({
      date: t.datum,
      paymentType: t.zahlungsart,
      fund: t.geldmarktfonds,
      quantity: t.stueck,
      pricePerUnit: t.kurs,
      amount: t.betrag,
    }));

    const tradingTransactions = cashForAnalytics.length ? parseTradingTransactions(cashForAnalytics) : [];
    const tradingData = tradingTransactions.length ? calculatePnL(tradingTransactions) : null;

    window.currentTradingData = tradingData;
    window.currentTradingTransactions = tradingTransactions;

    $("out").innerHTML = "";

    let chartsRendered = false;
    const chartsBundle = cashForAnalytics.length ? createCharts(cashForAnalytics, interestForAnalytics) : null;
    const chartsElement = chartsBundle ? chartsBundle.element : null;
    const chartConfigs = chartsBundle ? chartsBundle.charts : [];

    let cashTabComponent = null;
    let mmfTabComponent = null;
    let tradingTabComponent = null;

    if (cashDisplay.length || interestDisplay.length || tradingTransactions.length) {
      const statsEl = document.createElement('div');
      statsEl.innerHTML = createStatsSummary(cashDisplay, interestDisplay);
      $("out").appendChild(statsEl);

      cashTabComponent = cashDisplay.length ? renderComponent('Cash-Transaktionen', cashDisplay, 'cash', { failedChecks }) : null;
      mmfTabComponent = interestDisplay.length ? renderComponent('Geldmarktfonds (MMF)', interestDisplay, 'interest') : null;
      tradingTabComponent = tradingTransactions.length ? renderTradingComponent(tradingData, tradingTransactions) : null;
      const supportComp = renderSupportComponent({
        cashCount: cashDisplay.length,
        mmfCount: interestDisplay.length,
        tradingCount: tradingTransactions.length,
        failedChecks
      });

      if (cashTabComponent || chartsElement || mmfTabComponent || tradingTabComponent || supportComp) {
        const tabs = createTabNavigationWithTrading({
          cash: cashTabComponent,
          charts: chartsElement,
          mmf: mmfTabComponent,
          trading: tradingTabComponent,
          support: supportComp,
          onChartsActivate: chartsBundle ? () => {
            if (!chartsRendered) {
              renderCharts(chartConfigs);
              chartsRendered = true;
            }
          } : null
        });
        if (tabs) {
          $("out").appendChild(tabs);
        }
      }
    }

    if (!cashTabComponent && chartsBundle && !chartsRendered) {
      renderCharts(chartConfigs);
      chartsRendered = true;
    }

    if (tradingData && tradingTransactions.length) {
      renderTradingCharts(tradingData, tradingTransactions);
    }

    if (!cashDisplay.length && !interestDisplay.length) {
      $("status").textContent = 'Keine Transaktionen gefunden – bitte prüfe das PDF.';
    } else if (failedChecks > 0) {
      $("status").textContent = `Fertig – ${failedChecks} widersprüchliche Salden erkannt. Downloads verfügbar, bitte Daten prüfen.`;
    } else {
      $("status").textContent = 'Fertig – Export bereit. Dateien jetzt herunterladen.';
    }

    applyRunButtonSuccess();
    scrollToResultsSummary();
  } catch (error) {
    console.error('Fehler bei der Verarbeitung:', error);
    $("status").textContent = 'Fehler: ' + (error && error.message ? error.message : error);
    applyRunButtonBase(false);
  }
}

// Ensure initial button styling state
applyRunButtonBase(true);
