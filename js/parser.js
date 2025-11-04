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
 * Parse the entire PDF and extract cash & interest transactions.
 * @param {PDFDocumentProxy} pdf
 * @param {{ updateStatus?: Function, updateProgress?: Function, footerBandPx?: number }} options
 * @returns {Promise<{ cash: Array<object>, interest: Array<object> }>}
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
  let cashColumnBoundaries = null;
  let interestColumnBoundaries = null;

  let isParsingCash = false;
  let isParsingInterest = false;

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

    // --- Section markers (unchanged) ---
    const cashStartMarker = items.find(item => {
      const t = item.text.trim();
      return t === 'UMSATZÜBERSICHT' || t === 'TRANSAZIONI SUL CONTO' || t === 'ACCOUNT TRANSACTIONS';
    });

    const cashEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('BARMITTELÜBERSICHT') || t.includes('CASH SUMMARY') || t.includes('BALANCE OVERVIEW');
    });

    const shouldProcessCash = isParsingCash || !!cashStartMarker;

    const interestStartMarker = items.find(item => {
      const t = item.text.trim();
      return t === 'TRANSAKTIONSÜBERSICHT' || t === 'TRANSACTION OVERVIEW' || t === 'TRANSACTIONS';
    });

    const interestEndMarker = items.find(item => {
      const t = item.text.trim();
      return t.includes('HINWEISE ZUM KONTOAUSZUG') || t.includes('NOTES TO ACCOUNT STATEMENT') || t.includes('ACCOUNT STATEMENT NOTES');
    });

    const shouldProcessInterest = isParsingInterest || !!interestStartMarker;

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
  }

  console.log(`Total cash transactions: ${allCashTransactions.length}`);
  console.log(`Total interest transactions: ${allInterestTransactions.length}`);
  return { cash: allCashTransactions, interest: allInterestTransactions };
}

// --- Generic and Cash-Specific Functions ---
function findCashHeaders(items) {
  const headerKeywords = [
    'DATUM', 'TYP', 'BESCHREIBUNG', 'ZAHLUNGSEINGANG', 'ZAHLUNGSAUSGANG', 'SALDO',
    // Italian equivalents
    'DATA', 'TIPO', 'DESCRIZIONE', 'IN ENTRATA', 'IN USCITA',
    // English equivalents
    'DATE', 'TYPE', 'DESCRIPTION', 'MONEY', 'IN', 'OUT', 'BALANCE'
  ];
  const potentialHeaders = items.filter(item =>
    item.text.trim().length > 2 &&
    item.text.trim() === item.text.trim().toUpperCase() &&
    headerKeywords.some(kw => item.text.includes(kw))
  );

  console.log('Potential headers found:', potentialHeaders.map(h => h.text.trim()));

  const matchAny = (labels) => potentialHeaders.find(p => labels.includes(p.text.trim())) || null;
  
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
    SALDO: matchAny(['SALDO', 'BALANCE']),
  };

  if (!headers.ZAHLUNGEN) {
    headers.ZAHLUNGSEINGANG = matchAny(['ZAHLUNGSEINGANG', 'IN ENTRATA']) || findCompositeHeader('MONEY', 'IN');
    headers.ZAHLUNGSAUSGANG = matchAny(['ZAHLUNGSAUSGANG', 'IN USCITA']) || findCompositeHeader('MONEY', 'OUT');
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

// expose helper so other modules can reuse sanity information
window.parsePDF = parsePDF;
window.parseCurrency = parseCurrency;
window.computeCashSanityChecks = computeCashSanityChecks;
window.findCashHeaders = findCashHeaders;
window.findInterestHeaders = findInterestHeaders;
