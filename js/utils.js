/* ===================== Helper & Locale ===================== */
const $ = (id) => document.getElementById(id);
const log = (m) => {
  const debugEl = $("debug");
  if (!debugEl) return;
  const t = new Date().toISOString().slice(11, 19);
  debugEl.innerHTML += `[${t}] ${m}<br>`;
};

let pdf = null;

const strip = (s = "") =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const month = {
  // German
  Jan: 0, Januar: 0,
  Feb: 1, Februar: 1,
  Mär: 2, März: 2, Mrz: 2, Marz: 2,
  Apr: 3, April: 3,
  Mai: 4,
  Jun: 5, Juni: 5,
  Jul: 6, Juli: 6,
  Aug: 7, August: 7,
  Sep: 8, Sept: 8, September: 8,
  Okt: 9, Oktober: 9,
  Nov: 10, November: 10,
  Dez: 11, Dezember: 11,
  // Italian (abbrev and full)
  Gen: 0, Gennaio: 0,
  Febb: 1, Febbraio: 1, Feb: 1,
  Mar: 2, Marzo: 2,
  Aprile: 3, Apr: 3,
  Mag: 4, Maggio: 4,
  Giu: 5, Giugno: 5,
  Lug: 6, Luglio: 6,
  Ago: 7, Agosto: 7,
  Set: 8, Sett: 8, Settembre: 8,
  Ott: 9, Ottobre: 9,
  Nov: 10, Novembre: 10,
  Dic: 11, Dicembre: 11,
};

// Debug toggle functionality (kept for backwards compatibility)
const dbgToggle = $("dbg");
if (dbgToggle) {
  dbgToggle.onchange = (e) => {
    const debugEl = $("debug");
    if (debugEl) {
      debugEl.style.display = e.target.checked ? "block" : "none";
    }
  };
}

// Money field keys for formatting
const moneyKeys = [
  "incoming",
  "outgoing",
  "balance",
  "price",
  "amount",
  "zahlungseingang",
  "zahlungsausgang",
  "saldo",
  "kurs",
  "betrag",
];

/* ===================== PDF.js Init ===================== */
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js";

/* ===================== PDF Processing Functions ===================== */
async function items(pn) {
  const page = await pdf.getPage(pn), tc = await page.getTextContent();
  return tc.items
    .filter(t => t.str.trim())
    .map(t => {
      const [, , , , x, y] = t.transform;
      return { str: t.str, x: Math.round(x), y: Math.round(y), x2: Math.round(x + t.width) };
    })
    .filter(t => t.y > 50);
} 
