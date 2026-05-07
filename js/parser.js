/* ====================================================================
 * PDF Transaction Parser (ported from standalone working logic)
 * ====================================================================
 * The implementation below mirrors the standalone script provided by
 * the user. It exposes the same parsing behaviour while allowing the
 * surrounding app code to handle UI concerns (status/progress display
 * and rendering of results).
 * ==================================================================== */

const PARSER_NOOP = () => {};

// --- Simple, Y-only footer band (adjust this) ---
const FOOTER_BOTTOM_BAND = 120; // points from the bottom to drop (try 150–220)

/**
 * Parse the entire PDF and extract cash, interest, and portfolio transactions.
 * @param {PDFDocumentProxy} pdf
 * @param {{ updateStatus?: Function, updateProgress?: Function, footerBandPx?: number }} options
 * @returns {Promise<{ cash: Array<object>, interest: Array<object>, portfolio: Array<object> }>}
 */
async function parsePDF(pdf, options = {}) {
  console.log('Starting PDF parsing...');
  const updateStatus = options.updateStatus || PARSER_NOOP;
  const updateProgress = options.updateProgress || PARSER_NOOP;

  // allow runtime override for band size
  const footerBandPx = Number.isFinite(options.footerBandPx)
    ? options.footerBandPx
    : FOOTER_BOTTOM_BAND;

  updateStatus('Parsing PDF...');
  let allCashTransactions = [];
  let allInterestTransactions = [];
  let allPortfolioPositions = [];
  let allCryptoPositions = [];
  let cashColumnBoundaries = null;
  let interestColumnBoundaries = null;
  let portfolioColumnBoundaries = null;
  let cryptoColumnBoundaries = null;

  let isParsingCash = false;
  let isParsingInterest = false;
  let isParsingPortfolio = false;
  let isParsingCrypto = false;
  let isFrench = false;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    console.log(`--- Processing Page ${pageNum} ---`);
    updateStatus(`Processing page ${pageNum} of ${pdf.numPages}`);
    updateProgress(pageNum, pdf.numPages);

    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageItems = textContent.items.map(item => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height,
    }));
    console.log(`Page ${pageNum}: Found ${pageItems.length} total text items.`);

    // --- Simple Y-only footer clipping ---
    // pdf.js text y=0 is near the bottom; larger y is higher on the page.
    // We just drop everything with y <= footerBandPx (the bottom band).
    const footerY = footerBandPx;
    let items = pageItems.filter(it => it.y > footerY);

    // --- French detection (persists across pages once set) ---
    if (!isFrench) {
      isFrench = items.some(it => {
        const t = it.text.trim();
        return t === 'SYNTHÈSE DU RELEVÉ DE COMPTE' ||
               t === 'APERÇU DU SOLDE' ||
               t === 'REMARQUES SUR LE RELEVÉ DE COMPTE' ||
               t === "ENTRÉE D'ARGENT" || t === 'ENTRÉE D’ARGENT';
      });
      if (isFrench) console.log('Detected French statement');
    }

    // --- Section markers ---
    const cashStartMarker = items.find(item => {
      const t = item.text.trim();
      return t === 'UMSATZÜBERSICHT' || t === 'TRANSAZIONI SUL CONTO' || t === 'ACCOUNT TRANSACTIONS' ||
             (isFrench && t === 'TRANSACTIONS');
    });

    const cashEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('BARMITTELÜBERSICHT') || t.includes('CASH SUMMARY') || t.includes('BALANCE OVERVIEW') ||
             (isFrench && (t.includes('APERÇU DU SOLDE') || t.includes('REMARQUES SUR LE RELEVÉ')));
    });

    const shouldProcessCash = isParsingCash || !!cashStartMarker;

    const interestStartMarker = items.find(item => {
      const t = item.text.trim();
      // In French statements, "TRANSACTIONS" is the cash section, not interest.
      return t === 'TRANSAKTIONSÜBERSICHT' || t === 'TRANSACTION OVERVIEW' ||
             (!isFrench && t === 'TRANSACTIONS');
    });

    const interestEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('HINWEISE ZUM KONTOAUSZUG') || t.includes('NOTES TO ACCOUNT STATEMENT') || t.includes('ACCOUNT STATEMENT NOTES');
    });

    const shouldProcessInterest = isParsingInterest || !!interestStartMarker;

    // --- Portfolio Section Markers ---
    const portfolioStartMarker = items.find(item => {
      const t = item.text.trim();
      return t === 'POSITIONEN' || t === 'POSITIONS' || 
             (t.includes('DEPOTAUSZUG') && !t.includes('SEITE'));
    });

    const portfolioEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('ANZAHL POSITIONEN') || 
             t.includes('NUMBER OF POSITIONS') ||
             t === 'Achtung:' || 
             t === 'NOTE:' || 
             t === 'ATTENTION:';
    });

    const shouldProcessPortfolio = isParsingPortfolio || !!portfolioStartMarker;

    // --- Crypto Section Markers ---
    const cryptoStartMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('CRYPTO-ÜBERSICHT') || t.includes('CRYPTO OVERVIEW');
    });

    const cryptoEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('ANZAHL DER POSITIONEN') || 
             t.includes('NUMBER OF POSITIONS') ||
             t.includes('KURSWERT IN EUR') && t.includes('SUMME');
    });

    const shouldProcessCrypto = isParsingCrypto || !!cryptoStartMarker;

    // --- Cash Transaction Parsing Logic ---
    if (shouldProcessCash) {
      let cashItems = [...items];
      if (cashStartMarker) {
        cashItems = cashItems.filter(item => item.y <= cashStartMarker.y);
      }
      if (cashEndMarker) {
        cashItems = cashItems.filter(item => item.y > cashEndMarker.y);
      }

      let cashHeaders = findCashHeaders(cashItems);
      if (cashHeaders) {
        cashColumnBoundaries = calculateCashColumnBoundaries(cashHeaders);
        console.log('Found new Cash headers and boundaries:', cashColumnBoundaries);
      }

      if (cashColumnBoundaries) {
        const pageCashTransactions = extractTransactionsFromPage(cashItems, cashColumnBoundaries, 'cash');
        console.log(`Page ${pageNum}: Extracted ${pageCashTransactions.length} cash transactions.`);
        allCashTransactions = allCashTransactions.concat(pageCashTransactions);
      }
    }
    if (cashEndMarker) {
      isParsingCash = false;
    } else if (shouldProcessCash) {
      isParsingCash = true;
    }

    // --- Interest Transaction Parsing Logic ---
    if (shouldProcessInterest) {
      let interestItems = [...items];
      if (interestStartMarker) {
        interestItems = interestItems.filter(item => item.y <= interestStartMarker.y);
      }
      if (interestEndMarker) {
        interestItems = interestItems.filter(item => item.y > interestEndMarker.y);
      }

      let interestHeaders = findInterestHeaders(interestItems);
      if (interestHeaders) {
        interestColumnBoundaries = calculateInterestColumnBoundaries(interestHeaders);
        console.log('Found new Interest headers and boundaries:', interestColumnBoundaries);
      } else if (isParsingInterest && interestColumnBoundaries) {
        console.log(`Page ${pageNum}: No new interest headers found, continuing with previous boundaries.`);
      }

      if (interestColumnBoundaries) {
        const pageInterestTransactions = extractTransactionsFromPage(interestItems, interestColumnBoundaries, 'interest');
        console.log(`Page ${pageNum}: Extracted ${pageInterestTransactions.length} interest transactions.`);
        allInterestTransactions = allInterestTransactions.concat(pageInterestTransactions);
      }
    }
    if (interestEndMarker) {
      isParsingInterest = false;
    } else if (shouldProcessInterest) {
      isParsingInterest = true;
    }

    // --- Portfolio Position Parsing Logic ---
    if (shouldProcessPortfolio) {
      let portfolioItems = [...items];
      if (portfolioStartMarker) {
        portfolioItems = portfolioItems.filter(item => item.y <= portfolioStartMarker.y);
      }
      if (portfolioEndMarker) {
        portfolioItems = portfolioItems.filter(item => item.y > portfolioEndMarker.y);
      }

      // Log raw portfolio items for debugging
      const debugLog = window.debugLog || console.log;
      if (pageNum === 1) {
        debugLog(`\n=== RAW PORTFOLIO ITEMS (Page ${pageNum}) ===`);
        debugLog(`Total portfolio items: ${portfolioItems.length}`);
        portfolioItems.slice(0, 50).forEach((item, idx) => {
          debugLog(`Item ${idx}: X=${item.x.toFixed(1)}, Y=${item.y.toFixed(1)}, Text="${item.text}"`);
        });
        if (portfolioItems.length > 50) {
          debugLog(`... and ${portfolioItems.length - 50} more items`);
        }
      }

      let portfolioHeaders = findPortfolioHeaders(portfolioItems);
      if (portfolioHeaders) {
        portfolioColumnBoundaries = calculatePortfolioColumnBoundaries(portfolioHeaders);
        console.log('Found new Portfolio headers and boundaries:', portfolioColumnBoundaries);
      } else if (isParsingPortfolio && portfolioColumnBoundaries) {
        console.log(`Page ${pageNum}: No new portfolio headers found, continuing with previous boundaries.`);
      }

      if (portfolioColumnBoundaries) {
        const pagePortfolioPositions = extractPortfolioPositions(portfolioItems, portfolioColumnBoundaries);
        console.log(`Page ${pageNum}: Extracted ${pagePortfolioPositions.length} portfolio positions.`);
        allPortfolioPositions = allPortfolioPositions.concat(pagePortfolioPositions);
      }
    }
    if (portfolioEndMarker) {
      isParsingPortfolio = false;
    } else if (shouldProcessPortfolio) {
      isParsingPortfolio = true;
    }

    // --- Crypto Position Parsing Logic ---
    if (shouldProcessCrypto) {
      let cryptoItems = [...items];
      if (cryptoStartMarker) {
        cryptoItems = cryptoItems.filter(item => item.y <= cryptoStartMarker.y);
      }
      if (cryptoEndMarker) {
        cryptoItems = cryptoItems.filter(item => item.y > cryptoEndMarker.y);
      }

      let cryptoHeaders = findCryptoHeaders(cryptoItems);
      if (cryptoHeaders) {
        cryptoColumnBoundaries = calculateCryptoColumnBoundaries(cryptoHeaders);
        console.log('Found new Crypto headers and boundaries:', cryptoColumnBoundaries);
      } else if (isParsingCrypto && cryptoColumnBoundaries) {
        console.log(`Page ${pageNum}: No new crypto headers found, continuing with previous boundaries.`);
      }

      if (cryptoColumnBoundaries) {
        const pageCryptoPositions = extractCryptoPositions(cryptoItems, cryptoColumnBoundaries);
        console.log(`Page ${pageNum}: Extracted ${pageCryptoPositions.length} crypto positions.`);
        allCryptoPositions = allCryptoPositions.concat(pageCryptoPositions);
      }
    }
    if (cryptoEndMarker) {
      isParsingCrypto = false;
    } else if (shouldProcessCrypto) {
      isParsingCrypto = true;
    }
  }

  console.log(`Total cash transactions: ${allCashTransactions.length}`);
  console.log(`Total interest transactions: ${allInterestTransactions.length}`);
  console.log(`Total portfolio positions: ${allPortfolioPositions.length}`);
  console.log(`Total crypto positions: ${allCryptoPositions.length}`);
  return { 
    cash: allCashTransactions, 
    interest: allInterestTransactions, 
    portfolio: allPortfolioPositions,
    crypto: allCryptoPositions
  };
}

// --- Generic and Cash-Specific Functions ---
function findCashHeaders(items) {
  const headerKeywords = [
    'DATUM', 'TYP', 'BESCHREIBUNG', 'ZAHLUNGSEINGANG', 'ZAHLUNGSAUSGANG', 'SALDO',
    // Italian equivalents
    'DATA', 'TIPO', 'DESCRIZIONE', 'IN ENTRATA', 'IN USCITA',
    // English equivalents
    'DATE', 'TYPE', 'DESCRIPTION', 'MONEY', 'IN', 'OUT', 'BALANCE',
    // French equivalents (DATE/TYPE/DESCRIPTION already covered above)
    'ENTRÉE', 'SORTIE', "D'ARGENT", 'D’ARGENT', 'SOLDE'
  ];
  const potentialHeaders = items.filter(item =>
    item.text.trim().length > 2 &&
    item.text.trim() === item.text.trim().toUpperCase() &&
    headerKeywords.some(kw => item.text.includes(kw))
  );

  console.log('Potential headers found:', potentialHeaders.map(h => h.text.trim()));

  const matchAny = (labels) => potentialHeaders.find(p => labels.includes(p.text.trim())) || null;
  
  // Helper to find vertically-stacked French headers like "ENTRÉE" above "D'ARGENT"
  // (different lines, similar x). pdf.js y: larger = higher on page, so the bottom
  // word has a lower y than the top word.
  // Picks the bottom candidate with the smallest |x - top.x| so we pair correctly
  // when multiple identical bottom words exist (e.g., "D'ARGENT" under both ENTRÉE
  // and SORTIE).
  const findStackedHeader = (top, bottoms) => {
    const bottomList = Array.isArray(bottoms) ? bottoms : [bottoms];
    const tops = potentialHeaders.filter(p => p.text.trim() === top);
    for (const t of tops) {
      const candidates = potentialHeaders.filter(p => {
        const txt = p.text.trim();
        return bottomList.includes(txt) &&
               p.y < t.y &&
               (t.y - p.y) < 30 &&
               Math.abs(p.x - t.x) < 60;
      });
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => Math.abs(a.x - t.x) - Math.abs(b.x - t.x));
      const below = candidates[0];
      return {
        text: `${top} ${below.text.trim()}`,
        x: t.x,
        y: t.y,
        width: Math.max(t.width || 0, below.width || 0),
        height: (t.y - below.y) + (below.height || 0),
      };
    }
    return null;
  };

  // Helper to find headers that might be split into multiple text items (like "MONEY IN")
  const findCompositeHeader = (keyword1, keyword2) => {
    const single = potentialHeaders.find(p => {
      const t = p.text.trim();
      return t === `${keyword1} ${keyword2}` || t === keyword1 + keyword2;
    });
    if (single) return single;
    const first = potentialHeaders.filter(p => p.text.trim() === keyword1);
    for (const f of first) {
      const nearby = potentialHeaders.find(p => {
        return p.text.trim() === keyword2 && 
               Math.abs(p.y - f.y) < 2 &&
               p.x > f.x && p.x < f.x + 100;
      });
      if (nearby) {
        return {
          text: `${keyword1} ${keyword2}`,
          x: f.x,
          y: f.y,
          width: nearby.x + nearby.width - f.x,
          height: Math.max(f.height, nearby.height)
        };
      }
    }
    return null;
  };

  let headers = {
    DATUM: matchAny(['DATUM', 'DATA', 'DATE']),
    TYP: matchAny(['TYP', 'TIPO', 'TYPE']),
    BESCHREIBUNG: matchAny(['BESCHREIBUNG', 'DESCRIZIONE', 'DESCRIPTION']),
    ZAHLUNGEN: potentialHeaders.find(p => {
      const t = p.text.trim();
      return (t.includes('ZAHLUNGSEINGANG') && t.includes('ZAHLUNGSAUSGANG')) ||
             (t.includes('IN ENTRATA') && t.includes('IN USCITA')) ||
             (t.includes('MONEY IN') && t.includes('MONEY OUT'));
    }) || null,
    ZAHLUNGSEINGANG: null,
    ZAHLUNGSAUSGANG: null,
    SALDO: matchAny(['SALDO', 'BALANCE', 'SOLDE']),
  };

  if (!headers.ZAHLUNGEN) {
    headers.ZAHLUNGSEINGANG = matchAny(['ZAHLUNGSEINGANG', 'IN ENTRATA'])
      || findCompositeHeader('MONEY', 'IN')
      || findStackedHeader('ENTRÉE', ["D'ARGENT", 'D’ARGENT']);
    headers.ZAHLUNGSAUSGANG = matchAny(['ZAHLUNGSAUSGANG', 'IN USCITA'])
      || findCompositeHeader('MONEY', 'OUT')
      || findStackedHeader('SORTIE', ["D'ARGENT", 'D’ARGENT']);
  }
  
  console.log('Matched headers:', {
    DATUM: headers.DATUM?.text,
    TYP: headers.TYP?.text,
    BESCHREIBUNG: headers.BESCHREIBUNG?.text,
    ZAHLUNGSEINGANG: headers.ZAHLUNGSEINGANG?.text,
    ZAHLUNGSAUSGANG: headers.ZAHLUNGSAUSGANG?.text,
    SALDO: headers.SALDO?.text
  });

  if (!headers.DATUM || !headers.TYP || !headers.BESCHREIBUNG || !headers.SALDO) return null;
  if (!headers.ZAHLUNGEN && (!headers.ZAHLUNGSEINGANG || !headers.ZAHLUNGSAUSGANG)) return null;
  return headers;
}

function calculateCashColumnBoundaries(headers) {
  let zahlungseingangEnd;
  let zahlungsausgangStart;
  let paymentsStart;

  if (headers.ZAHLUNGEN) {
    const zahlungenMidpoint = headers.ZAHLUNGEN.x + headers.ZAHLUNGEN.width / 2;
    zahlungseingangEnd = zahlungenMidpoint;
    zahlungsausgangStart = zahlungenMidpoint;
    paymentsStart = headers.ZAHLUNGEN.x - 5;
  } else {
    zahlungseingangEnd = headers.ZAHLUNGSAUSGANG.x - 5;
    zahlungsausgangStart = headers.ZAHLUNGSAUSGANG.x - 5;
    paymentsStart = headers.ZAHLUNGSEINGANG.x - 5;
  }

  return {
    datum: { start: 0, end: headers.TYP.x - 5 },
    typ: { start: headers.TYP.x - 5, end: headers.BESCHREIBUNG.x - 5 },
    beschreibung: { start: headers.BESCHREIBUNG.x - 5, end: paymentsStart },
    zahlungseingang: { start: paymentsStart, end: zahlungseingangEnd },
    zahlungsausgang: { start: zahlungsausgangStart, end: headers.SALDO.x - 5 },
    saldo: { start: headers.SALDO.x - 5, end: Infinity },
    headerY: headers.DATUM.y,
  };
}

// --- Interest-Specific Functions ---
function findInterestHeaders(items) {
  const headerKeywords = ['DATUM', 'ZAHLUNGSART', 'GELDMARKTFONDS', 'STÜCK', 'KURS PRO STÜCK', 'BETRAG'];
  const potentialHeaders = items.filter(item =>
    item.text.trim().length > 2 &&
    item.text.trim().toUpperCase() === item.text.trim() &&
    headerKeywords.some(kw => item.text.trim().includes(kw))
  );

  let headers = {
    DATUM: potentialHeaders.find(p => p.text.trim() === 'DATUM'),
    ZAHLUNGSART: potentialHeaders.find(p => p.text.trim() === 'ZAHLUNGSART'),
    GELDMARKTFONDS: potentialHeaders.find(p => p.text.trim() === 'GELDMARKTFONDS'),
    STÜCK: potentialHeaders.find(p => p.text.trim() === 'STÜCK'),
    'KURS PRO STÜCK': potentialHeaders.find(p => p.text.trim() === 'KURS PRO STÜCK'),
    BETRAG: potentialHeaders.find(p => p.text.trim() === 'BETRAG'),
  };

  if (Object.values(headers).some(h => !h)) {
    return null;
  }
  return headers;
}

function calculateInterestColumnBoundaries(headers) {
  return {
    datum: { start: 0, end: headers.ZAHLUNGSART.x - 5 },
    zahlungsart: { start: headers.ZAHLUNGSART.x - 5, end: headers.GELDMARKTFONDS.x - 5 },
    geldmarktfonds: { start: headers.GELDMARKTFONDS.x - 5, end: headers.STÜCK.x - 5 },
    stueck: { start: headers.STÜCK.x - 5, end: headers['KURS PRO STÜCK'].x - 5 },
    kurs: { start: headers['KURS PRO STÜCK'].x - 5, end: headers.BETRAG.x - 5 },
    betrag: { start: headers.BETRAG.x - 5, end: Infinity },
    headerY: headers.DATUM.y,
  };
}

// --- Generic Transaction Extraction ---
function extractTransactionsFromPage(items, boundaries, type) {
  const contentItems = items.filter(item => item.y < boundaries.headerY - 5 && item.text.trim() !== '');
  if (contentItems.length === 0) return [];

  contentItems.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  if (contentItems.length > 0) {
    const avgHeight = contentItems.reduce((sum, item) => sum + item.height, 0) / contentItems.length || 10;
    const gapThreshold = avgHeight * 1.5;
    let currentRow = [contentItems[0]];
    for (let i = 1; i < contentItems.length; i++) {
      if (contentItems[i - 1].y - contentItems[i].y > gapThreshold) {
        rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push(contentItems[i]);
    }
    rows.push(currentRow);
  }

  const transactions = [];
  for (const rowItems of rows) {
    let transaction = {};

    if (type === 'cash') {
      transaction = {
        datum: '',
        typ: '',
        beschreibung: '',
        zahlungseingang: '',
        zahlungsausgang: '',
        saldo: '',
      };
      const financialItems = [];
      for (const item of rowItems) {
        if (item.x < boundaries.datum.end) transaction.datum += ' ' + item.text;
        else if (item.x < boundaries.typ.end) transaction.typ += ' ' + item.text;
        else if (item.x < boundaries.beschreibung.end) transaction.beschreibung += ' ' + item.text;
        else financialItems.push(item);
      }
      financialItems.sort((a, b) => a.x - b.x);
      if (financialItems.length > 0) transaction.saldo = financialItems.pop().text;
      for (const item of financialItems) {
        if (item.x < boundaries.zahlungseingang.end) transaction.zahlungseingang += ' ' + item.text;
        else if (item.x < boundaries.zahlungsausgang.end) transaction.zahlungsausgang += ' ' + item.text;
      }
    } else if (type === 'interest') {
      transaction = {
        datum: '',
        zahlungsart: '',
        geldmarktfonds: '',
        stueck: '',
        kurs: '',
        betrag: '',
      };
      const otherItems = [];
      for (const item of rowItems) {
        if (item.x < boundaries.datum.end) transaction.datum += ' ' + item.text;
        else if (item.x < boundaries.zahlungsart.end) transaction.zahlungsart += ' ' + item.text;
        else if (item.x < boundaries.geldmarktfonds.end) transaction.geldmarktfonds += ' ' + item.text;
        else otherItems.push(item);
      }
      otherItems.sort((a, b) => a.x - b.x);
      if (otherItems.length > 0) {
        const betragItem = otherItems.pop();
        transaction.betrag = betragItem.text;
      }
      for (const item of otherItems) {
        if (item.x < boundaries.stueck.end) transaction.stueck += ' ' + item.text;
        else if (item.x < boundaries.kurs.end) transaction.kurs += ' ' + item.text;
      }
    }

    Object.keys(transaction).forEach(key => {
      transaction[key] = transaction[key].trim().replace(/\s+/g, ' ');
    });
    if (Object.values(transaction).some(val => val !== '')) {
      transactions.push(transaction);
    }
  }
  return transactions;
}

// --- Portfolio-Specific Functions ---
function findPortfolioHeaders(items) {
  const headerKeywords = [
    'STK.', 'NOMINALE', 'WERTPAPIERBEZEICHNUNG', 'KURS PRO STÜCK', 'KURSWERT IN EUR',
    // English equivalents
    'QUANTITY', 'SECURITY DESCRIPTION', 'PRICE PER UNIT', 'MARKET VALUE'
  ];
  const potentialHeaders = items.filter(item =>
    item.text.trim().length > 2 &&
    item.text.trim() === item.text.trim().toUpperCase() &&
    headerKeywords.some(kw => item.text.includes(kw))
  );

  console.log('Potential portfolio headers found:', potentialHeaders.map(h => h.text.trim()));

  const matchAny = (labels) => potentialHeaders.find(p => labels.some(label => p.text.trim().includes(label))) || null;

  let headers = {
    QUANTITY: matchAny(['STK.', 'NOMINALE', 'QUANTITY']),
    SECURITY: matchAny(['WERTPAPIERBEZEICHNUNG', 'SECURITY DESCRIPTION', 'SECURITY']),
    PRICE: matchAny(['KURS PRO STÜCK', 'PRICE PER UNIT', 'PRICE']),
    VALUE: matchAny(['KURSWERT IN EUR', 'MARKET VALUE', 'VALUE'])
  };

  console.log('Matched portfolio headers:', {
    QUANTITY: headers.QUANTITY?.text,
    SECURITY: headers.SECURITY?.text,
    PRICE: headers.PRICE?.text,
    VALUE: headers.VALUE?.text
  });

  if (!headers.QUANTITY || !headers.SECURITY || !headers.PRICE || !headers.VALUE) return null;
  return headers;
}

function calculatePortfolioColumnBoundaries(headers) {
  return {
    quantity: { start: 0, end: headers.SECURITY.x - 5 },
    security: { start: headers.SECURITY.x - 5, end: headers.PRICE.x - 5 },
    price: { start: headers.PRICE.x - 5, end: headers.VALUE.x - 5 },
    value: { start: headers.VALUE.x - 5, end: Infinity },
    headerY: headers.QUANTITY.y,
  };
}

// Helper function to group items into lines by Y-coordinate
function groupItemsIntoLines(items, eps = 1) {
  const rows = new Map();
  for (const it of items) {
    const y = Math.round(it.y / eps) * eps;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(it);
  }
  const lines = [];
  for (const y of [...rows.keys()].sort((a, b) => b - a)) { // Sort descending (top to bottom)
    const row = rows.get(y).sort((a, b) => a.x - b.x);
    lines.push({ y, items: row, text: row.map(r => r.text).join(' ').trim() });
  }
  return lines;
}

// Helper to parse European number format
function parseEuropeanNumber(str) {
  if (!str || typeof str !== 'string') return null;
  const cleanStr = str.replace(/\s|\u202f/g, '').replace(/\./g, '').replace(',', '.');
  const v = Number(cleanStr);
  return Number.isFinite(v) ? v : null;
}

// Helper function to extract right-side data (price/date/value)
function extractRightSideData(rightItems, text, boundaries, position) {
  // Extract date from text first
  const DATE_PATTERN = /(\d{2}\.\d{2}\.\d{4})/;
  const dateMatch = DATE_PATTERN.exec(text);
  if (dateMatch && !position.priceDate) {
    position.priceDate = dateMatch[1];
  }

  // Extract numeric values based on X position
  // Sort items by X position to process in order (left to right: price -> date -> value)
  const sortedItems = [...rightItems].sort((a, b) => a.x - b.x);
  
  // Track what we've found
  let foundPrice = position.pricePerUnit !== null;
  let foundValue = position.marketValueEUR !== null;
  
  for (const item of sortedItems) {
    const num = parseEuropeanNumber(item.text);
    
    // Check if this item is in the price column
    const isInPriceColumn = item.x >= boundaries.price.start && item.x < boundaries.value.start;
    // Check if this item is in the value column
    const isInValueColumn = item.x >= boundaries.value.start;
    
    if (num !== null) {
      // Price column - explicitly check if we're in price column range
      if (isInPriceColumn && !foundPrice) {
        // Always set price, even if it's 0 (don't skip zero prices)
        position.pricePerUnit = num;
        foundPrice = true;
      }
      // Value column
      else if (isInValueColumn && !foundValue) {
        position.marketValueEUR = num;
        foundValue = true;
      }
    } else {
      // Check if this is a date string (not a number but in right column)
      const itemDateMatch = DATE_PATTERN.exec(item.text);
      if (itemDateMatch && !position.priceDate) {
        position.priceDate = itemDateMatch[1];
      }
      
      // Special case: if we see "0,00" or "0.00" text in price column, treat as zero price
      if (isInPriceColumn && !foundPrice && (item.text.includes('0,00') || item.text.includes('0.00') || item.text.trim() === '0')) {
        position.pricePerUnit = 0;
        foundPrice = true;
      }
    }
  }
  
  // Fallback: if we still don't have a price but have a value, and we see "0,00" anywhere in price column area
  if (!foundPrice && foundValue) {
    // Look for any item in price column that might be zero
    const priceColumnItems = rightItems.filter(item => 
      item.x >= boundaries.price.start && item.x < boundaries.value.start
    );
    for (const item of priceColumnItems) {
      const text = item.text.trim();
      if (text === '0' || text === '0,00' || text === '0.00' || text === '0,0' || text === '0.0') {
        position.pricePerUnit = 0;
        foundPrice = true;
        break;
      }
    }
  }
}

function extractPortfolioPositions(items, boundaries) {
  // Use global debugLog function or fallback to console.log
  const debugLog = window.debugLog || ((msg) => { console.log(msg); });
  
  debugLog('=== EXTRACTING PORTFOLIO POSITIONS ===');
  debugLog(`Total items: ${items.length}`);
  debugLog(`Boundaries: ${JSON.stringify(boundaries)}`);
  
  // Filter items below headers
  const contentItems = items.filter(item => item.y < boundaries.headerY - 5 && item.text.trim() !== '');
  debugLog(`Content items (below headers): ${contentItems.length}`);
  
  if (contentItems.length === 0) return [];

  // Group items into lines
  const lines = groupItemsIntoLines(contentItems, 2); // eps=2 for slight tolerance
  debugLog(`Grouped into lines: ${lines.length}`);
  
  // Log all lines for debugging
  debugLog('=== ALL LINES (top to bottom) ===');
  lines.forEach((line, idx) => {
    debugLog(`Line ${idx}: Y=${line.y.toFixed(1)}, Text="${line.text}", Items=${line.items.length}`);
    line.items.forEach((item, itemIdx) => {
      debugLog(`  Item ${itemIdx}: X=${item.x.toFixed(1)}, Text="${item.text}"`);
    });
  });

  const positions = [];
  let currentPosition = null;

  // Regex patterns
  const QTY_LINE = /^\s*([\d.]+,\d{2,6}|\d+([.,]\d+)?)\s*(Stk\.?|Nominale)\b/i;
  const ISIN_PATTERN = /\bISIN:\s*([A-Z]{2}[A-Z0-9]{10})\b/;
  const COUNTRY_PATTERN = /^Lagerland\s*:\s*(.+)$/i;
  const DATE_PATTERN = /(\d{2}\.\d{2}\.\d{4})/;
  const SKIP_PATTERNS = /(POSITIONEN|STK\.?\s*\/\s*NOMINALE|KURS PRO ST[ÜU]CK|KURSWERT IN EUR|DEPOTAUSZUG|SEITE|Aufstellung|ANZAHL POSITIONEN)/i;
  const SKIP_NAME_PATTERNS = /(Wertpapierrechnung|Wertpapierrechnung in Deutschland)/i;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text;

    debugLog(`\n--- Processing Line ${i} ---`);
    debugLog(`Text: "${text}"`);
    debugLog(`Y: ${line.y.toFixed(1)}, Items: ${line.items.length}`);

    // Skip header lines and section markers
    if (SKIP_PATTERNS.test(text)) {
      debugLog('  -> SKIPPED (header/section marker)');
      continue;
    }

    // Check if this is a quantity line (start of new position)
    const qtyMatch = QTY_LINE.exec(text);
    if (qtyMatch) {
      debugLog('  -> QUANTITY LINE DETECTED');
      debugLog(`  Match: qty="${qtyMatch[1]}", unit="${qtyMatch[3]}"`);
      
      // Save previous position if exists
      if (currentPosition && currentPosition.quantity != null) {
        debugLog(`  -> Saving previous position: name="${currentPosition.name}", nameExtra="${currentPosition.nameExtra}"`);
        positions.push(currentPosition);
      }

      // Start new position
      const qtyStr = qtyMatch[1];
      const unit = qtyMatch[3];
      currentPosition = {
        quantity: parseEuropeanNumber(qtyStr),
        unit: /^stk/i.test(unit) ? 'Stk' : unit,
        name: '',
        nameExtra: '',
        isin: '',
        pricePerUnit: null,
        priceDate: '',
        marketValueEUR: null,
        custodyCountry: ''
      };
      debugLog(`  -> Created new position: quantity=${currentPosition.quantity}, unit="${currentPosition.unit}"`);

      // Check if name and price/value are on the same line (e.g., "0,060721 Stk. ASML Holding N.V. 1.206,80 73,28")
      // Extract name from the line (everything between quantity and right-aligned data)
      const rightItems = line.items.filter(item => item.x >= boundaries.price.start);
      const leftItems = line.items.filter(item => item.x < boundaries.price.start);
      
      // Remove quantity items from left items
      const nameItems = leftItems.filter(item => {
        const itemText = item.text.trim();
        return !QTY_LINE.test(itemText) && itemText.length > 0;
      });
      
      if (nameItems.length > 0) {
        const nameText = nameItems.map(item => item.text).join(' ').trim();
        if (nameText.length > 0 && !SKIP_NAME_PATTERNS.test(nameText)) {
          currentPosition.name = nameText;
          debugLog(`  -> Extracted name from same line: "${nameText}"`);
        }
      }

      // Extract right-aligned data (price/date/value)
      debugLog(`  -> Right-aligned items on this line: ${rightItems.length}`);
      extractRightSideData(rightItems, text, boundaries, currentPosition);

      continue;
    }

    // If we have a current position, process this line
    if (currentPosition) {
      debugLog(`  -> Processing for position (quantity=${currentPosition.quantity})`);
      
      // Skip "Wertpapierrechnung in Deutschland" lines - these are not part of the name
      if (SKIP_NAME_PATTERNS.test(text)) {
        debugLog('  -> SKIPPED (Wertpapierrechnung pattern)');
        continue;
      }

      // Check for ISIN - once we find ISIN, stop adding to name
      const isinMatch = ISIN_PATTERN.exec(text);
      if (isinMatch) {
        currentPosition.isin = isinMatch[1];
        debugLog(`  -> ISIN FOUND: ${currentPosition.isin}`);
        continue;
      }

      // Check for custody country
      const countryMatch = COUNTRY_PATTERN.exec(text);
      if (countryMatch) {
        currentPosition.custodyCountry = countryMatch[1].trim();
        debugLog(`  -> COUNTRY FOUND: ${currentPosition.custodyCountry}`);
        // After country, we might have right-side data on next lines
        continue;
      }

      // Check if this line has right-aligned data (price/date/value)
      const rightItems = line.items.filter(item => item.x >= boundaries.price.start);
      const hasRightData = rightItems.length > 0;
      debugLog(`  -> Has right-aligned data: ${hasRightData} (${rightItems.length} items)`);
      
      if (hasRightData) {
        debugLog(`  -> Extracting right-side data`);
        extractRightSideData(rightItems, text, boundaries, currentPosition);
        continue;
      }
      
      // If we haven't found ISIN yet and this is not right-aligned data, it's part of the security name
      // The name comes after the quantity line and before the ISIN line
      // Also skip if this looks like a quantity line (shouldn't happen but safety check)
      const isQtyLine = QTY_LINE.test(text);
      const hasSkipPattern = SKIP_NAME_PATTERNS.test(text);
      const shouldAddToName = text.trim().length > 0 && 
                               !currentPosition.isin && 
                               !hasRightData && 
                               !isQtyLine &&
                               !hasSkipPattern;
      
      debugLog(`  -> Name extraction check:`);
      debugLog(`     text.trim().length > 0: ${text.trim().length > 0}`);
      debugLog(`     !currentPosition.isin: ${!currentPosition.isin}`);
      debugLog(`     !hasRightData: ${!hasRightData}`);
      debugLog(`     !isQtyLine: ${!isQtyLine}`);
      debugLog(`     !hasSkipPattern: ${!hasSkipPattern}`);
      debugLog(`     shouldAddToName: ${shouldAddToName}`);
      
      if (shouldAddToName) {
        const cleanText = text.trim();
        if (cleanText.length > 0) {
          if (currentPosition.name === '') {
            currentPosition.name = cleanText;
            debugLog(`  -> ✓ SET NAME: "${cleanText}"`);
          } else {
            currentPosition.nameExtra = currentPosition.nameExtra 
              ? (currentPosition.nameExtra + ' ' + cleanText)
              : cleanText;
            debugLog(`  -> ✓ ADDED TO NAMEEXTRA: "${cleanText}" (full: "${currentPosition.nameExtra}")`);
          }
        }
      } else {
        debugLog(`  -> ✗ NOT ADDING TO NAME (conditions not met)`);
      }
    } else {
      debugLog(`  -> No current position, skipping`);
    }
  }
  
  // Don't forget the last position
  if (currentPosition && currentPosition.quantity != null) {
    debugLog(`\n--- Saving last position ---`);
    debugLog(`Name: "${currentPosition.name}", NameExtra: "${currentPosition.nameExtra}"`);
    positions.push(currentPosition);
  }

  debugLog(`\n=== EXTRACTED ${positions.length} POSITIONS ===`);
  positions.forEach((pos, idx) => {
    debugLog(`Position ${idx + 1}:`);
    debugLog(`  Quantity: ${pos.quantity} ${pos.unit}`);
    debugLog(`  Name: "${pos.name}"`);
    debugLog(`  NameExtra: "${pos.nameExtra}"`);
    debugLog(`  ISIN: ${pos.isin}`);
    debugLog(`  Price: ${pos.pricePerUnit}, Value: ${pos.marketValueEUR}`);
  });

  // Clean up and compute derived values
  return positions.map(pos => {
    // Combine name and nameExtra - ensure we have a name
    let fullName = '';
    if (pos.name && pos.nameExtra) {
      fullName = `${pos.name} ${pos.nameExtra}`;
    } else if (pos.name) {
      fullName = pos.name;
    } else if (pos.nameExtra) {
      fullName = pos.nameExtra; // Fallback if name is empty but nameExtra exists
    }
    
    console.log(`Final position name: "${fullName}" (name: "${pos.name}", nameExtra: "${pos.nameExtra}")`);
    
    // Compute value if missing
    let computedValue = null;
    if (pos.quantity != null && pos.pricePerUnit != null) {
      computedValue = Math.round(pos.quantity * pos.pricePerUnit * 100) / 100;
    }

    return {
      quantity: pos.quantity,
      unit: pos.unit,
      name: fullName.trim(),
      isin: pos.isin,
      pricePerUnit: pos.pricePerUnit,
      priceDate: pos.priceDate,
      marketValueEUR: pos.marketValueEUR || computedValue,
      custodyCountry: pos.custodyCountry,
      computedValue: computedValue
    };
  });
}

function parseCurrency(str) {
  if (!str || typeof str !== 'string') return 0;
  const cleanStr = str
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  return isNaN(parseFloat(cleanStr)) ? 0 : parseFloat(cleanStr);
}

/**
 * Attach derived metadata (optional helper, used by UI layer).
 */
function computeCashSanityChecks(transactions) {
  let failedChecks = 0;
  const enhancedTransactions = transactions.map((t, index, list) => {
    let sanityCheckOk = true;
    if (index > 0) {
      const prevSaldo = parseCurrency(list[index - 1].saldo);
      const eingang = parseCurrency(t.zahlungseingang);
      const ausgang = parseCurrency(t.zahlungsausgang);
      const currentSaldo = parseCurrency(t.saldo);
      if (!isNaN(prevSaldo) && !isNaN(currentSaldo)) {
        const expectedSaldo = prevSaldo + eingang - ausgang;
        if (Math.abs(expectedSaldo - currentSaldo) > 0.02) {
          sanityCheckOk = false;
          failedChecks++;
        }
      }
    }
    return { ...t, _sanityCheckOk: sanityCheckOk };
  });
  return { transactions: enhancedTransactions, failedChecks };
}

// --- Crypto-Specific Functions ---
function findCryptoHeaders(items) {
  const headerKeywords = [
    'NOMINALE', 'INSTRUMENT NAME', 'PREIS JE ANTEIL', 'KAUFWERT IN EUR', 'GEWINN / VERLUST',
    // English equivalents
    'QUANTITY', 'INSTRUMENT', 'PRICE PER UNIT', 'PURCHASE VALUE', 'GAIN / LOSS'
  ];
  const potentialHeaders = items.filter(item =>
    item.text.trim().length > 2 &&
    item.text.trim() === item.text.trim().toUpperCase() &&
    headerKeywords.some(kw => item.text.includes(kw))
  );

  console.log('Potential crypto headers found:', potentialHeaders.map(h => h.text.trim()));

  const matchAny = (labels) => potentialHeaders.find(p => labels.some(label => p.text.trim().includes(label))) || null;

  let headers = {
    QUANTITY: matchAny(['NOMINALE', 'QUANTITY']),
    NAME: matchAny(['INSTRUMENT NAME', 'INSTRUMENT', 'NAME']),
    PRICE: matchAny(['PREIS JE ANTEIL', 'PRICE PER UNIT', 'PRICE']),
    PURCHASE_VALUE: matchAny(['KAUFWERT IN EUR', 'PURCHASE VALUE']),
    GAIN_LOSS: matchAny(['GEWINN / VERLUST', 'GAIN / LOSS', 'GEWINN', 'VERLUST'])
  };

  console.log('Matched crypto headers:', {
    QUANTITY: headers.QUANTITY?.text,
    NAME: headers.NAME?.text,
    PRICE: headers.PRICE?.text,
    PURCHASE_VALUE: headers.PURCHASE_VALUE?.text,
    GAIN_LOSS: headers.GAIN_LOSS?.text
  });

  if (!headers.QUANTITY || !headers.NAME || !headers.PRICE) return null;
  return headers;
}

function calculateCryptoColumnBoundaries(headers) {
  // Calculate boundaries based on header positions
  const priceEnd = headers.PURCHASE_VALUE ? headers.PURCHASE_VALUE.x - 5 : headers.GAIN_LOSS?.x - 5 || headers.PRICE.x + 100;
  const purchaseEnd = headers.GAIN_LOSS ? headers.GAIN_LOSS.x - 5 : headers.PURCHASE_VALUE?.x + 100 || Infinity;
  
  return {
    quantity: { start: 0, end: headers.NAME.x - 5 },
    name: { start: headers.NAME.x - 5, end: headers.PRICE.x - 5 },
    price: { start: headers.PRICE.x - 5, end: priceEnd },
    purchaseValue: headers.PURCHASE_VALUE ? { start: headers.PURCHASE_VALUE.x - 5, end: purchaseEnd } : null,
    gainLoss: headers.GAIN_LOSS ? { start: headers.GAIN_LOSS.x - 5, end: Infinity } : null,
    headerY: headers.QUANTITY.y,
  };
}

function extractCryptoPositions(items, boundaries) {
  // Use global debugLog function or fallback to console.log
  const debugLog = window.debugLog || ((msg) => { console.log(msg); });
  
  debugLog('=== EXTRACTING CRYPTO POSITIONS ===');
  debugLog(`Total items: ${items.length}`);
  debugLog(`Boundaries: ${JSON.stringify(boundaries)}`);
  
  // Filter items below headers
  const contentItems = items.filter(item => item.y < boundaries.headerY - 5 && item.text.trim() !== '');
  debugLog(`Content items (below headers): ${contentItems.length}`);
  
  if (contentItems.length === 0) return [];

  // Group items into lines
  const lines = groupItemsIntoLines(contentItems, 2);
  debugLog(`Grouped into lines: ${lines.length}`);

  const positions = [];
  let currentPosition = null;

  // Regex patterns
  const QTY_PATTERN = /^([\d.]+,\d{2,6}|\d+([.,]\d+)?)\s/; // Quantity at start of line
  const STK_PATTERN = /Stk\.?/i;
  const DATE_PATTERN = /(\d{2}\.\d{2}\.\d{4})/;
  const PERCENT_PATTERN = /(-?\d+[,.]?\d*)%/;
  const SKIP_PATTERNS = /(CRYPTO-ÜBERSICHT|NOMINALE|INSTRUMENT NAME|PREIS JE ANTEIL|KAUFWERT|GEWINN|VERLUST|ANZAHL DER POSITIONEN|KURSWERT|SUMME|Aufstellung)/i;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text;

    debugLog(`\n--- Processing Crypto Line ${i} ---`);
    debugLog(`Text: "${text}"`);

    // Skip header lines and section markers
    if (SKIP_PATTERNS.test(text)) {
      debugLog('  -> SKIPPED (header/section marker)');
      continue;
    }

    // Check if this line starts with a quantity number (new position)
    // Pattern: "0,083216  Ethereum (Ethereum) 2.288,4 214,9 -24,47 190,43"
    const qtyMatch = QTY_PATTERN.exec(text.trim());
    if (qtyMatch) {
      debugLog('  -> QUANTITY LINE DETECTED');
      
      // Save previous position if exists
      if (currentPosition && currentPosition.quantity != null) {
        debugLog(`  -> Saving previous position: name="${currentPosition.name}"`);
        positions.push(currentPosition);
      }

      // Start new position
      const qtyStr = qtyMatch[1];
      currentPosition = {
        quantity: parseEuropeanNumber(qtyStr),
        unit: 'Stk', // Will be confirmed on next line
        name: '',
        pricePerUnit: null,
        priceDate: '',
        purchaseValueEUR: null,
        gainLossEUR: null,
        gainLossPercent: null,
        marketValueEUR: null
      };
      debugLog(`  -> Created new position: quantity=${currentPosition.quantity}`);

      // Extract name and right-aligned data from this line
      const rightItems = line.items.filter(item => item.x >= boundaries.price.start);
      const leftItems = line.items.filter(item => item.x < boundaries.price.start);
      
      // Extract name from left items (excluding quantity - first item)
      const nameItems = leftItems.slice(1); // Skip first item (quantity)
      
      if (nameItems.length > 0) {
        const nameText = nameItems.map(item => item.text).join(' ').trim();
        if (nameText.length > 0) {
          currentPosition.name = nameText;
          debugLog(`  -> Extracted name: "${nameText}"`);
        }
      }

      // Extract right-aligned data (price, purchase value, gain/loss, market value)
      extractCryptoRightSideData(rightItems, text, boundaries, currentPosition);
      continue;
    }

    // Check if this is the "Stk." line with date and percentage
    if (STK_PATTERN.test(text) && currentPosition) {
      debugLog('  -> STK LINE DETECTED (with date/percentage)');
      
      // Extract date
      const dateMatch = DATE_PATTERN.exec(text);
      if (dateMatch && !currentPosition.priceDate) {
        currentPosition.priceDate = dateMatch[1];
        debugLog(`  -> Extracted date: ${currentPosition.priceDate}`);
      }
      
      // Extract percentage
      const percentMatch = PERCENT_PATTERN.exec(text);
      if (percentMatch && currentPosition.gainLossPercent === null) {
        currentPosition.gainLossPercent = parseEuropeanNumber(percentMatch[1]);
        debugLog(`  -> Extracted percentage: ${currentPosition.gainLossPercent}%`);
      }
      
      // Position is complete, save it
      if (currentPosition.quantity != null) {
        debugLog(`  -> Saving crypto position: name="${currentPosition.name}"`);
        positions.push(currentPosition);
        currentPosition = null;
      }
      continue;
    }

    // If we have a current position, check for additional data
    if (currentPosition) {
      // Check if this line has right-aligned data
      const rightItems = line.items.filter(item => item.x >= boundaries.price.start);
      const hasRightData = rightItems.length > 0;
      
      if (hasRightData) {
        extractCryptoRightSideData(rightItems, text, boundaries, currentPosition);
        continue;
      }
      
      // Otherwise, this might be part of the crypto name (shouldn't happen often)
      if (text.trim().length > 0 && !hasRightData && !STK_PATTERN.test(text)) {
        const cleanText = text.trim();
        if (currentPosition.name === '') {
          currentPosition.name = cleanText;
          debugLog(`  -> ✓ SET NAME: "${cleanText}"`);
        } else {
          currentPosition.name = currentPosition.name + ' ' + cleanText;
          debugLog(`  -> ✓ ADDED TO NAME: "${cleanText}"`);
        }
      }
    }
  }

  // Don't forget the last position
  if (currentPosition && currentPosition.quantity != null) {
    debugLog(`\n--- Saving last crypto position ---`);
    positions.push(currentPosition);
  }

  debugLog(`\n=== EXTRACTED ${positions.length} CRYPTO POSITIONS ===`);
  
  // Normalize output to match portfolio format exactly
  return positions.map(pos => {
    // Use marketValueEUR if available, otherwise calculate from purchaseValue + gainLoss
    let marketValue = pos.marketValueEUR;
    if (!marketValue && pos.purchaseValueEUR !== null && pos.gainLossEUR !== null) {
      marketValue = pos.purchaseValueEUR + pos.gainLossEUR;
    }
    if (!marketValue && pos.purchaseValueEUR !== null) {
      marketValue = pos.purchaseValueEUR;
    }
    
    // Return same structure as portfolio positions
    return {
      quantity: pos.quantity,
      unit: pos.unit,
      name: pos.name.trim(),
      isin: '', // Cryptos don't have ISINs - empty string to match portfolio format
      pricePerUnit: pos.pricePerUnit,
      priceDate: pos.priceDate,
      marketValueEUR: marketValue,
      custodyCountry: 'BitGo Deutschland GmbH' // From PDF text
    };
  });
}

function extractCryptoRightSideData(rightItems, text, boundaries, position) {
  // Extract date
  const DATE_PATTERN = /(\d{2}\.\d{2}\.\d{4})/;
  const dateMatch = DATE_PATTERN.exec(text);
  if (dateMatch && !position.priceDate) {
    position.priceDate = dateMatch[1];
  }

  // Sort items by X position (left to right)
  const sortedItems = [...rightItems].sort((a, b) => a.x - b.x);
  
  const numbers = [];
  for (const item of sortedItems) {
    const num = parseEuropeanNumber(item.text);
    if (num !== null) {
      numbers.push({ num, x: item.x, text: item.text });
    }
  }

  debugLog(`  -> Found ${numbers.length} numbers in right columns`);

  // Extract based on column boundaries and order
  // Expected order: Price, Purchase Value, Gain/Loss EUR, Market Value
  for (let idx = 0; idx < numbers.length; idx++) {
    const { num, x, text: numText } = numbers[idx];
    
    // Price column (first number in price range)
    if (x >= boundaries.price.start && 
        (!boundaries.purchaseValue || x < boundaries.purchaseValue.start)) {
      if (position.pricePerUnit === null) {
        position.pricePerUnit = num;
        debugLog(`  -> Extracted price: ${num} (from X=${x.toFixed(1)})`);
      }
    }
    // Purchase value column
    else if (boundaries.purchaseValue && 
             x >= boundaries.purchaseValue.start && 
             (!boundaries.gainLoss || x < boundaries.gainLoss.start)) {
      if (position.purchaseValueEUR === null) {
        position.purchaseValueEUR = num;
        debugLog(`  -> Extracted purchase value: ${num} (from X=${x.toFixed(1)})`);
      }
    }
    // Gain/Loss column - could be negative
    else if (boundaries.gainLoss && x >= boundaries.gainLoss.start) {
      // This is the gain/loss EUR value (negative numbers are handled by parseEuropeanNumber)
      if (position.gainLossEUR === null) {
        position.gainLossEUR = num;
        debugLog(`  -> Extracted gain/loss EUR: ${num} (from X=${x.toFixed(1)})`);
      }
    }
  }
  
  // Market value is usually the last number on the line (rightmost)
  if (numbers.length > 0) {
    const lastNum = numbers[numbers.length - 1];
    // If we haven't set market value yet and this number is far right, it's likely the market value
    if (position.marketValueEUR === null && lastNum.x >= (boundaries.gainLoss?.start || boundaries.purchaseValue?.start || boundaries.price.start + 150)) {
      position.marketValueEUR = lastNum.num;
      debugLog(`  -> Extracted market value: ${lastNum.num} (last number, X=${lastNum.x.toFixed(1)})`);
    }
  }
}

// expose helper so other modules can reuse sanity information
window.parsePDF = parsePDF;
window.parseCurrency = parseCurrency;
window.computeCashSanityChecks = computeCashSanityChecks;
window.findCashHeaders = findCashHeaders;
window.findInterestHeaders = findInterestHeaders;
window.findPortfolioHeaders = findPortfolioHeaders;
window.findCryptoHeaders = findCryptoHeaders;
