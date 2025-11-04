# Trade Republic PDF Converter

Open-source browser tool to turn Trade Republic account statements (PDF) into structured CSV, Excel, and JSON files. Everything runs locally in the browser—no trackers, payments, or SaaS backends.

## Features
- PDF parsing for the "Umsatzübersicht" and interest sections using the latest parser from the original project.
- In-browser analysis with progress feedback and sanity checks on balances.
- Export buttons for CSV, XLSX (via SheetJS), and JSON.
- Optional charts and trading P&L views rendered with Chart.js.

## Getting Started
1. Clone the repository:
   ```bash
   git clone https://github.com/your-account/Trade-Republic-CSV-Excel.git
   cd Trade-Republic-CSV-Excel
   ```
2. Serve the project locally (any static file server works). For example:
   ```bash
   npx serve .
   ```
3. Open `http://localhost:3000` (or the port shown by your server) and select a Trade Republic PDF.

## Development
- All client-side code lives in `js/`.
- `js/parser.js` is kept reusable so you can import it elsewhere if needed.
- Styles rely on Tailwind via CDN plus `styles.css` for custom tweaks.

## Roadmap Ideas
- Add automated tests using PDF fixtures.
- Provide language-specific parser overrides.
- Offer optional integrations via plug-ins instead of hard-coded adapters.

