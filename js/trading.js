/* ===================== Securities Parser ===================== */

// Utility function for number formatting
function formatNumber(value) {
  if (value == null || isNaN(value)) return '0.00';
  return parseFloat(value).toLocaleString('de-DE', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  });
}

function parseSecurities(pages) {
  // --- helpers ---
  const strip = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  const toNumberEU = s => {
    if (!s) return null;
    s = s.replace(/\s|\u202f/g,"").replace(/\./g,"").replace(",",".");
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  // Group page items into lines by y (like I did in Python)
  const groupLines = (items, eps=1) => {
    const rows = new Map();
    for (const it of items) {
      const y = Math.round(it.y/eps)*eps;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    const lines = [];
    for (const y of [...rows.keys()].sort((a,b)=>a-b)) {
      const row = rows.get(y).sort((a,b)=>a.x-b.x);
      lines.push({ y, text: row.map(r=>r.str).join(" ").trim() });
    }
    return lines;
  };

  // --- regex anchors (robust to missing spaces, fractional qty, EU numbers) ---
  const QTY_LINE = /^\s*([\d.]+,\d{2,6}|\d+)\s*(Stk\.?|Nominale)\b/i;
  // Updated TAIL pattern to handle format: price total (without date)
  const TAIL = /(\d{1,3}(?:[\.,]\d{3})*,\d{2})\s+(\d{1,3}(?:[\.,]\d{3})*,\d{2})\s*$/;
  // Alternative pattern with date: price date total  
  const TAIL_WITH_DATE = /(\d{1,3}(?:[\.,]\d{3})*,\d{2})\s*(\d{2}\.\d{2}\.\d{4})\s*(\d{1,3}(?:[\.,]\d{3})*,\d{2})\s*$/;
  const ISIN = /\bISIN:\s*([A-Z]{2}[A-Z0-9]{10})\b/;
  const SKIP = /(POSITIONEN|STK\.?\s*\/\s*NOMINALE|KURS PRO ST[ÜU]CK|KURSWERT IN EUR|DEPOTAUSZUG|SEITE)/i;

  const records = [];
  const allLines = pages.flatMap(pg => groupLines(pg));

  console.log('=== PARSING SECURITIES PDF ===');
  console.log('Total lines found:', allLines.length);

  for (const { text } of allLines) {
    // Start of a new position?
    const m = QTY_LINE.exec(text);
    if (m) {
      let [, qtyStr, unit] = m;
      let namePart = text;
      let price=null, priceDate="", total=null;

      console.log('Found position line:', text);

      // Try to match pattern with date first
      let t = TAIL_WITH_DATE.exec(text);
      if (t) {
        price     = toNumberEU(t[1]);
        priceDate = t[2];
        total     = toNumberEU(t[3]);
        namePart  = text.slice(0, t.index).trim();
        console.log('Extracted with date: price=', price, 'date=', priceDate, 'total=', total);
      } else {
        // Try pattern without date: price total
        t = TAIL.exec(text);
        if (t) {
          price     = toNumberEU(t[1]);
          priceDate = "15.09.2025"; // Use document date as fallback
          total     = toNumberEU(t[2]);
          namePart  = text.slice(0, t.index).trim();
          console.log('Extracted without date: price=', price, 'total=', total);
        } else {
          console.log('NO TAIL MATCH for line:', text);
        }
      }
      // Remove the leading "qty + unit" from the name section
      namePart = namePart.replace(QTY_LINE, "").replace(/^[.\s]+/, "").trim();

      records.push({
        quantity: toNumberEU(qtyStr),
        unit: /^stk/i.test(unit) ? "Stk" : unit,
        name: namePart,
        nameExtra: "",
        isin: "",
        pricePerUnit: price,
        priceDate,
        marketValueEUR: total,
        custodyCountry: ""
      });
      continue;
    }

    // If we're inside a record, attach extra lines
    if (records.length) {
      const last = records[records.length - 1];

      const im = ISIN.exec(text);
      if (im) { 
        last.isin = im[1]; 
        console.log('Found ISIN:', im[1], 'for', last.name);
        continue; 
      }

      if (/^Lagerland\s*:/i.test(text)) {
        const [, rest=""] = text.split(":");
        last.custodyCountry = strip(rest);
        continue;
      }

      // short descriptor that belongs to the security name
      if (!SKIP.test(text) && text.length <= 80 && !ISIN.test(text)) {
        last.nameExtra = last.nameExtra ? (last.nameExtra + " " + text.trim()) : text.trim();
      }
    }
  }

  // optional: derived check
  for (const r of records) {
    if (r.quantity != null && r.pricePerUnit != null) {
      r.computedValue = Math.round(r.quantity * r.pricePerUnit * 100)/100;
    } else {
      r.computedValue = null;
    }
  }
  
  console.log('=== FINAL PARSED SECURITIES ===');
  console.log('Total records:', records.length);
  records.forEach((r, i) => {
    console.log(`${i+1}. ${r.name} (${r.isin}) - €${r.marketValueEUR} - ${r.priceDate}`);
  });
  
  return records;
}

function enrichTradingDataWithSecurities(tradingData, securities) {
  if (!securities || securities.length === 0) return tradingData;
  
  console.log('=== DEBUGGING SECURITIES ENRICHMENT ===');
  console.log('Securities loaded:', securities.length);
  console.log('Sample securities:', securities.slice(0, 3));
  
  // Create a map of securities by ISIN for quick lookup
  const securitiesMap = new Map();
  securities.forEach(sec => {
    if (sec.isin) {
      securitiesMap.set(sec.isin, sec);
      console.log('Mapped:', sec.isin, '→', sec.name, '€' + sec.marketValueEUR);
    }
  });
  
  console.log('Total securities mapped:', securitiesMap.size);
  console.log('Trading positions to match:', tradingData.pnlSummary.length);
  
  // Enrich trading positions with current portfolio data
  const enrichedPnL = tradingData.pnlSummary.map(pos => {
    const security = securitiesMap.get(pos.isin);
    console.log('Checking position:', pos.stockName, 'ISIN:', pos.isin, 'Found:', !!security);
    
    if (security && pos.isOpen) {
      // Calculate unrealized P&L for open positions
      const currentValue = security.marketValueEUR || 0;
      const unrealizedPnL = currentValue - pos.costBasis;
      const unrealizedPnLPercentage = pos.costBasis > 0 ? (unrealizedPnL / pos.costBasis * 100) : 0;
      
      console.log('MATCH FOUND:', pos.stockName, 'Current:', currentValue, 'Cost:', pos.costBasis, 'P&L:', unrealizedPnL);
      
      return {
        ...pos,
        currentValue,
        currentPrice: security.pricePerUnit,
        currentQuantity: security.quantity,
        priceDate: security.priceDate,
        unrealizedPnL,
        unrealizedPnLPercentage,
        totalPnL: pos.realizedGainLoss + unrealizedPnL,
        hasCurrentData: true
      };
    }
    console.log('NO MATCH for:', pos.stockName, 'ISIN:', pos.isin, 'Open:', pos.isOpen);
    return {
      ...pos,
      hasCurrentData: false,
      unrealizedPnL: 0,
      totalPnL: pos.realizedGainLoss
    };
  });
  
  // Calculate enriched totals
  const totalCurrentValue = enrichedPnL.reduce((sum, pos) => 
    sum + (pos.currentValue || pos.costBasis), 0);
  const totalUnrealizedPnL = enrichedPnL.reduce((sum, pos) => 
    sum + (pos.unrealizedPnL || 0), 0);
  const totalPnL = tradingData.totalRealized + totalUnrealizedPnL;
  
  return {
    ...tradingData,
    pnlSummary: enrichedPnL,
    totalCurrentValue,
    totalUnrealizedPnL,
    totalPnL,
    hasSecuritiesData: true,
    securitiesDate: securities[0]?.priceDate || ""
  };
}

/* ===================== Trading P&L Analysis ===================== */

function parseTradingTransactions(cashTransactions) {
  const tradingTxs = [];
  
  cashTransactions.forEach(tx => {
    if (tx.type !== 'Handel') return;
    
    const desc = tx.description || '';
    
    // Extract trading information from description
    // Pattern: "Ausführung Handel Direktkauf Kauf/Verkauf [ISIN] [STOCK NAME] [ID]"
    const tradeMatch = desc.match(/Ausführung Handel Direkt(kauf|verkauf)\s+(Kauf|Verkauf)\s+([A-Z0-9]{12})\s+(.+?)\s+(\d+)$/);
    
    if (!tradeMatch) return;
    
    const [, , action, isin, stockName, tradeId] = tradeMatch;
    const isBuy = action === 'Kauf';
    
    // Parse amount - incoming for sells, outgoing for buys
    let amount = 0;
    if (isBuy && tx.outgoing) {
      amount = parseFloat(tx.outgoing.replace(/\./g, '').replace(',', '.').replace('€', '').trim()) || 0;
    } else if (!isBuy && tx.incoming) {
      amount = parseFloat(tx.incoming.replace(/\./g, '').replace(',', '.').replace('€', '').trim()) || 0;
    }
    
    if (amount <= 0) return;
    
    tradingTxs.push({
      date: tx.date,
      isin,
      stockName: stockName.trim(),
      action,
      isBuy,
      amount,
      tradeId,
      balance: tx.balance
    });
  });
  
  return tradingTxs.sort((a, b) => new Date(parseGermanDate(a.date)) - new Date(parseGermanDate(b.date)));
}

function calculatePnL(tradingTransactions) {
  const positions = {};
  const pnlSummary = [];
  
  // Group by ISIN
  tradingTransactions.forEach(tx => {
    if (!positions[tx.isin]) {
      positions[tx.isin] = {
        isin: tx.isin,
        stockName: tx.stockName,
        buys: [],
        sells: [],
        totalBought: 0,
        totalSold: 0,
        transactions: []
      };
    }
    
    const pos = positions[tx.isin];
    pos.transactions.push(tx);
    
    if (tx.isBuy) {
      pos.buys.push(tx);
      pos.totalBought += tx.amount;
    } else {
      pos.sells.push(tx);
      pos.totalSold += tx.amount;
    }
  });
  
  // Calculate P&L for each position
  Object.values(positions).forEach(pos => {
    const realizedPnL = pos.totalSold - pos.totalBought;
    
    // Determine position status
    let status, statusIcon, costBasis, realizedGainLoss;
    
    if (pos.totalBought > 0 && pos.totalSold === 0) {
      // Pure buy-and-hold position
      status = 'Offen (Holding)';
      statusIcon = 'Offen';
      costBasis = pos.totalBought;
      realizedGainLoss = 0; // No realized gains yet
    } else if (pos.totalBought === 0 && pos.totalSold > 0) {
      // Sold without buying (maybe from previous periods)
      status = 'Verkauf (Unbekannter Einkauf)';
      statusIcon = 'Verkauf';
      costBasis = 0;
      realizedGainLoss = pos.totalSold; // All as gain (since we don't know cost)
    } else if (pos.totalBought > pos.totalSold) {
      // Partially sold position
      status = 'Teilweise verkauft';
      statusIcon = 'Teilweise';
      costBasis = pos.totalBought - pos.totalSold;
      realizedGainLoss = 0; // Net outflow, partial exit
    } else if (pos.totalSold > pos.totalBought) {
      // Sold more than bought (profitable exit or had previous holdings)
      status = 'Komplett verkauft';
      statusIcon = 'Geschlossen';
      costBasis = 0;
      realizedGainLoss = pos.totalSold - pos.totalBought;
    } else {
      // Exactly balanced (rare)
      status = 'Ausgeglichen';
      statusIcon = 'Ausgeglichen';
      costBasis = 0;
      realizedGainLoss = 0;
    }
    
    pnlSummary.push({
      isin: pos.isin,
      stockName: pos.stockName,
      totalBought: pos.totalBought,
      totalSold: pos.totalSold,
      netCashFlow: realizedPnL, // Keep the cash flow calculation
      realizedGainLoss, // Actual trading gains/losses
      costBasis, // Money still invested
      status,
      statusIcon,
      isOpen: pos.totalSold < pos.totalBought,
      numBuys: pos.buys.length,
      numSells: pos.sells.length,
      totalTransactions: pos.transactions.length,
      firstTrade: pos.transactions[0]?.date,
      lastTrade: pos.transactions[pos.transactions.length - 1]?.date
    });
  });
  
  // Sort by absolute cash flow (biggest investments first)
  pnlSummary.sort((a, b) => Math.abs(b.netCashFlow) - Math.abs(a.netCashFlow));
  
  const totalInvested = pnlSummary.reduce((sum, pos) => sum + pos.costBasis, 0);
  const totalRealized = pnlSummary.reduce((sum, pos) => sum + pos.realizedGainLoss, 0);
  const openPositions = pnlSummary.filter(pos => pos.isOpen).length;
  const closedPositions = pnlSummary.filter(pos => !pos.isOpen).length;
  
  return {
    positions,
    pnlSummary,
    totalInvested, // Money currently tied up in stocks
    totalRealized, // Actual gains/losses realized
    totalNetCashFlow: pnlSummary.reduce((sum, pos) => sum + pos.netCashFlow, 0),
    totalTrades: tradingTransactions.length,
    totalVolume: tradingTransactions.reduce((sum, tx) => sum + tx.amount, 0),
    openPositions,
    closedPositions
  };
}

function parseGermanDate(dateStr) {
  // Parse dates like "04 März 2021"
  const months = {
    'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Mai': 4, 'Juni': 5,
    'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11,
    'Jan.': 0, 'Feb.': 1, 'Mär.': 2, 'Apr.': 3, 'Mai.': 4, 'Jun.': 5,
    'Jul.': 6, 'Aug.': 7, 'Sep.': 8, 'Okt.': 9, 'Nov.': 10, 'Dez.': 11,
    'Sept.': 8
  };
  
  const match = dateStr.match(/(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})/);
  if (!match) return new Date();
  
  const [, day, monthName, year] = match;
  const month = months[monthName];
  
  return new Date(parseInt(year), month || 0, parseInt(day));
}

function createTradingCharts(tradingData, tradingTransactions) {
  const container = document.createElement('div');
  container.className = 'grid gap-6 md:grid-cols-2';

  if (!tradingData || tradingData.pnlSummary.length === 0) {
    container.innerHTML = '<p class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Keine Trading-Daten gefunden.</p>';
    return container;
  }

  // P&L per Stock Chart
  const pnlChartBox = document.createElement('div');
  pnlChartBox.className = 'flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm';
  const pnlTitle = document.createElement('h4');
  pnlTitle.className = 'text-sm font-semibold uppercase tracking-wide text-slate-600';
  pnlTitle.textContent = 'Investment & Performance pro Aktie';
  const pnlCanvas = document.createElement('canvas');
  pnlCanvas.id = 'pnlChart';
  pnlChartBox.append(pnlTitle, pnlCanvas);
  container.appendChild(pnlChartBox);

  // Trading Volume Chart
  const volumeChartBox = document.createElement('div');
  volumeChartBox.className = 'flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm';
  const volumeTitle = document.createElement('h4');
  volumeTitle.className = 'text-sm font-semibold uppercase tracking-wide text-slate-600';
  volumeTitle.textContent = 'Kauf vs. Verkauf Volumen';
  const volumeCanvas = document.createElement('canvas');
  volumeCanvas.id = 'volumeChart';
  volumeChartBox.append(volumeTitle, volumeCanvas);
  container.appendChild(volumeChartBox);

  // Trading Timeline Chart
  if (tradingTransactions.length > 3) {
    const timelineChartBox = document.createElement('div');
    timelineChartBox.className = 'flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2';
    const timelineTitle = document.createElement('h4');
    timelineTitle.className = 'text-sm font-semibold uppercase tracking-wide text-slate-600';
    timelineTitle.textContent = 'Trading-Aktivität im Zeitverlauf';
    const timelineCanvas = document.createElement('canvas');
    timelineCanvas.id = 'tradingTimelineChart';
    timelineChartBox.append(timelineTitle, timelineCanvas);
    container.appendChild(timelineChartBox);
  }

  return container;
}

function renderTradingCharts(tradingData, tradingTransactions) {
  setTimeout(() => {
    try {
      if (!tradingData || tradingData.pnlSummary.length === 0) return;

      // P&L Chart - Show cost basis for open positions, realized gains for closed
      const topPositions = tradingData.pnlSummary.slice(0, 10);
      const pnlLabels = topPositions.map(pos => pos.stockName.length > 20 ? 
        pos.stockName.substring(0, 17) + '...' : pos.stockName);
      const pnlData = topPositions.map(pos => pos.isOpen ? -pos.costBasis : pos.realizedGainLoss);
      const pnlColors = topPositions.map(pos => pos.isOpen ? '#6c757d' : (pos.realizedGainLoss >= 0 ? '#10b981' : '#ef4444'));

      new Chart(document.getElementById('pnlChart').getContext('2d'), {
        type: 'bar',
        data: {
          labels: pnlLabels,
          datasets: [{
            label: 'Investment/P&L (€)',
            data: pnlData,
            backgroundColor: pnlColors,
            borderColor: pnlColors,
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const pos = topPositions[context.dataIndex];
                  if (pos.isOpen) {
                    return [
                      `Offene Position`,
                      `Investiert: ${pos.costBasis.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Gekauft: ${pos.totalBought.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Verkauft: ${pos.totalSold.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Trades: ${pos.totalTransactions}`
                    ];
                  } else {
                    return [
                      `Geschlossene Position`,
                      `Realisiert: ${pos.realizedGainLoss.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Gekauft: ${pos.totalBought.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Verkauft: ${pos.totalSold.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
                      `Trades: ${pos.totalTransactions}`
                    ];
                  }
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: value => value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0 })
              }
            },
            x: {
              ticks: { maxRotation: 45 }
            }
          }
        }
      });

      // Volume Chart
      const totalBuys = tradingData.pnlSummary.reduce((sum, pos) => sum + pos.totalBought, 0);
      const totalSells = tradingData.pnlSummary.reduce((sum, pos) => sum + pos.totalSold, 0);

      new Chart(document.getElementById('volumeChart').getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: ['Käufe', 'Verkäufe'],
          datasets: [{
            data: [totalBuys, totalSells],
            backgroundColor: ['#3b82f6', '#10b981'],
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: { position: 'bottom' },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const total = totalBuys + totalSells;
                  const percentage = ((context.parsed / total) * 100).toFixed(1);
                  return `${context.label}: ${context.parsed.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} (${percentage}%)`;
                }
              }
            }
          }
        }
      });

      // Trading Timeline Chart
      if (tradingTransactions.length > 3 && document.getElementById('tradingTimelineChart')) {
        const monthlyData = {};
        tradingTransactions.forEach(tx => {
          const date = parseGermanDate(tx.date);
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyData[monthKey]) {
            monthlyData[monthKey] = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0 };
          }
          if (tx.isBuy) {
            monthlyData[monthKey].buys++;
            monthlyData[monthKey].buyVolume += tx.amount;
          } else {
            monthlyData[monthKey].sells++;
            monthlyData[monthKey].sellVolume += tx.amount;
          }
        });

        const sortedMonths = Object.keys(monthlyData).sort();
        const buyVolumeData = sortedMonths.map(month => monthlyData[month].buyVolume);
        const sellVolumeData = sortedMonths.map(month => monthlyData[month].sellVolume);

        new Chart(document.getElementById('tradingTimelineChart').getContext('2d'), {
          type: 'line',
          data: {
            labels: sortedMonths.map(month => month.replace('-', '/')),
            datasets: [
              {
                label: 'Kauf-Volumen (€)',
                data: buyVolumeData,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: false,
                tension: 0.3
              },
              {
                label: 'Verkauf-Volumen (€)',
                data: sellVolumeData,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                fill: false,
                tension: 0.3
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { position: 'top' },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    return `${context.dataset.label}: ${context.parsed.y.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`;
                  }
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: value => value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0 })
                }
              }
            }
          }
        });
      }

    } catch(e) {
      console.error('Fehler beim Rendern der Trading-Charts:', e);
    }
  }, 100);
}

function createTradingStatsSummary(tradingData) {
  if (!tradingData || tradingData.pnlSummary.length === 0) {
    return '<div class="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">Keine Trading-Transaktionen gefunden</div>';
  }

  const formatCurrency = value => value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const valueTone = value => value >= 0 ? 'text-emerald-600' : 'text-rose-600';
  const createCard = (icon, label, value, tone = 'text-slate-900') => `
    <div class="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <span class="flex items-center gap-2 text-sm font-medium text-slate-600">
        <i data-feather="${icon}"></i>
        ${label}
      </span>
      <span class="text-sm font-semibold ${tone}">${value}</span>
    </div>
  `;

  const cards = [
    createCard('briefcase', 'Aktuell investiert:', formatCurrency(tradingData.totalInvested)),
    createCard('dollar-sign', 'Realisierte Gewinne/Verluste:', formatCurrency(tradingData.totalRealized), valueTone(tradingData.totalRealized)),
    createCard('arrow-down-up', 'Netto Cash Flow:', formatCurrency(tradingData.totalNetCashFlow), valueTone(tradingData.totalNetCashFlow)),
    createCard('trending-up', 'Offene Positionen:', tradingData.openPositions),
    createCard('check-circle', 'Geschlossene Positionen:', tradingData.closedPositions),
    createCard('repeat', 'Anzahl Trades:', tradingData.totalTrades),
    createCard('layers', 'Gehandelte Aktien:', tradingData.pnlSummary.length),
    createCard('bar-chart-2', 'Gesamtvolumen:', formatCurrency(tradingData.totalVolume))
  ];

  const html = `
    <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
      <header class="space-y-1">
        <h3 class="text-lg font-semibold text-slate-900">Trading Performance Übersicht</h3>
      </header>
      <div class="grid gap-3 md:grid-cols-2">
        ${cards.join('')}
      </div>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        <p class="font-semibold text-slate-900">Erläuterung</p>
        <ul class="mt-2 space-y-1 list-disc pl-5">
          <li><strong>Aktuell investiert:</strong> Geld, das noch in Aktien steckt (offene Positionen)</li>
          <li><strong>Realisierte Gewinne/Verluste:</strong> Tatsächliche Gewinne/Verluste aus verkauften Positionen</li>
          <li><strong>Netto Cash Flow:</strong> Verkäufe minus Käufe (negativ = mehr gekauft als verkauft)</li>
        </ul>
      </div>
    </section>
  `;

  setTimeout(() => {
    if (typeof feather !== 'undefined') {
      feather.replace();
    }
  }, 100);

  return html;
}

function createEnhancedTradingStatsSummary(tradingData) {
  if (!tradingData || tradingData.pnlSummary.length === 0) {
    return '<div class="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">Keine Trading-Transaktionen gefunden</div>';
  }

  const formatCurrency = value => value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const valueTone = value => value >= 0 ? 'text-emerald-600' : 'text-rose-600';
  const createCard = (icon, label, value, tone = 'text-slate-900') => `
    <div class="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <span class="flex items-center gap-2 text-sm font-medium text-slate-600">
        <i data-feather="${icon}"></i>
        ${label}
      </span>
      <span class="text-sm font-semibold ${tone}">${value}</span>
    </div>
  `;

  const cards = [
    createCard('briefcase', 'Aktuell investiert:', formatCurrency(tradingData.totalInvested)),
    createCard('dollar-sign', 'Realisierte Gewinne/Verluste:', formatCurrency(tradingData.totalRealized), valueTone(tradingData.totalRealized))
  ];

  if (tradingData.hasSecuritiesData) {
    cards.push(
      createCard('trending-up', 'Unrealisierte Gewinne/Verluste:', formatCurrency(tradingData.totalUnrealizedPnL), valueTone(tradingData.totalUnrealizedPnL)),
      createCard('pie-chart', 'Aktueller Portfolio-Wert:', formatCurrency(tradingData.totalCurrentValue)),
      createCard('target', 'Gesamt P&L:', formatCurrency(tradingData.totalPnL), valueTone(tradingData.totalPnL))
    );
  } else {
    cards.push(createCard('arrow-down-up', 'Netto Cash Flow:', formatCurrency(tradingData.totalNetCashFlow), valueTone(tradingData.totalNetCashFlow)));
  }

  cards.push(
    createCard('trending-up', 'Offene Positionen:', tradingData.openPositions),
    createCard('check-circle', 'Geschlossene Positionen:', tradingData.closedPositions),
    createCard('repeat', 'Anzahl Trades:', tradingData.totalTrades),
    createCard('layers', 'Gehandelte Aktien:', tradingData.pnlSummary.length),
    createCard('bar-chart-2', 'Gesamtvolumen:', formatCurrency(tradingData.totalVolume))
  );

  const explanationList = tradingData.hasSecuritiesData ? `
        <li><strong>Unrealisierte Gewinne/Verluste:</strong> Potenzielle Gewinne/Verluste basierend auf aktuellen Kursen</li>
        <li><strong>Aktueller Portfolio-Wert:</strong> Gesamtwert aller Positionen zum aktuellen Kurs</li>
        <li><strong>Gesamt P&L:</strong> Realisierte + unrealisierte Gewinne/Verluste</li>
      ` : `
        <li><strong>Netto Cash Flow:</strong> Verkäufe minus Käufe (negativ = mehr gekauft als verkauft)</li>
        <li><em>Für unrealisierte P&L bitte ein aktuelles Depot-PDF hochladen.</em></li>
      `;

  const html = `
    <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
      <header class="space-y-1">
        <h3 class="text-lg font-semibold text-slate-900">Trading Performance Übersicht</h3>
      </header>
      <div class="grid gap-3 md:grid-cols-2">
        ${cards.join('')}
      </div>
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        <p class="font-semibold text-slate-900">Erläuterung</p>
        <ul class="mt-2 space-y-1 list-disc pl-5">
          <li><strong>Aktuell investiert:</strong> Geld, das noch in Aktien steckt (offene Positionen)</li>
          <li><strong>Realisierte Gewinne/Verluste:</strong> Tatsächliche Gewinne/Verluste aus verkauften Positionen</li>
          ${explanationList}
        </ul>
      </div>
    </section>
  `;

  setTimeout(() => {
    if (typeof feather !== 'undefined') {
      feather.replace();
    }
  }, 100);

  return html;
}

// Securities PDF handling functions
function handleSecuritiesPdfUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const statusEl = document.getElementById('securities-upload-status');
  if (statusEl) {
    statusEl.textContent = 'PDF wird verarbeitet...';
    statusEl.className = 'text-sm font-medium text-slate-600';
  }
  
  const fileReader = new FileReader();
  fileReader.onload = function() {
    const typedarray = new Uint8Array(this.result);
    
    pdfjsLib.getDocument(typedarray).promise.then(function(pdf) {
      const promises = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        promises.push(pdf.getPage(i).then(function(page) {
          return page.getTextContent().then(function(textContent) {
            return textContent.items.map(item => ({
              str: item.str,
              x: item.transform[4],
              y: item.transform[5],
              x2: item.transform[4] + item.width
            }));
          });
        }));
      }
      
      Promise.all(promises).then(function(pages) {
        try {
          const securities = parseSecurities(pages);
          window.currentSecuritiesData = securities;
          
          if (statusEl) {
            statusEl.textContent = `✓ ${securities.length} Positionen geladen`;
            statusEl.className = 'text-sm font-semibold text-emerald-600';
          }
          
          // Refresh the trading component with enriched data
          if (window.currentTradingData) {
            // Find and refresh the active trading tab content
            const activeTab = document.querySelector('[data-tab-role="navigation"][data-active="true"]');
            if (activeTab && activeTab.textContent.includes('Trading')) {
              // Find the corresponding content div
              const activeContent = document.querySelector('[data-tab-role="panel"][data-active="true"]');
              if (activeContent) {
                // Regenerate the trading component with enriched data
                const enrichedComponent = renderTradingComponent(window.currentTradingData, window.currentTradingTransactions);
                activeContent.innerHTML = '';
                activeContent.appendChild(enrichedComponent);
              }
            }
          }
          
        } catch (error) {
          console.error('Error parsing securities PDF:', error);
          if (statusEl) {
            statusEl.textContent = '✗ Fehler beim Verarbeiten der PDF';
            statusEl.className = 'text-sm font-medium text-rose-600';
          }
        }
      });
    }).catch(function(error) {
      console.error('Error loading PDF:', error);
      if (statusEl) {
        statusEl.textContent = '✗ Fehler beim Laden der PDF';
        statusEl.className = 'text-sm font-medium text-rose-600';
      }
    });
  };
  
  fileReader.readAsArrayBuffer(file);
}

function clearSecuritiesData() {
  window.currentSecuritiesData = null;
  // Refresh the trading component
  if (window.currentTradingData) {
    const activeTab = document.querySelector('[data-tab-role="navigation"][data-active="true"]');
    if (activeTab && activeTab.textContent.includes('Trading')) {
      const activeContent = document.querySelector('[data-tab-role="panel"][data-active="true"]');
      if (activeContent) {
        const refreshedComponent = renderTradingComponent(window.currentTradingData, window.currentTradingTransactions);
        activeContent.innerHTML = '';
        activeContent.appendChild(refreshedComponent);
      }
    }
  }
}

function renderTradingTab() {
  const tradingComponent = renderTradingComponent(window.currentTradingData, window.currentTradingTransactions);
  const content = document.getElementById('content');
  if (content) {
    content.innerHTML = '';
    content.appendChild(tradingComponent);
  }
}
