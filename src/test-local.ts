/**
 * test-local.ts — run end-to-end pipeline locally without the HTTP server.
 *
 * Usage:
 *   1. Copy .env.example → .env and fill in SHEETS_KEY + SHEET_ID
 *   2. npx ts-node -r dotenv/config src/test-local.ts
 *
 * This will scrape a narrow 7-day window, parse any downloaded PDFs,
 * and push results directly to the Records tab of the Google Sheet.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { scrapeCASOS } from "./scraper/ca_sos";
import { parsePDFs } from "./processor/pdf_parser";
import { mapToRecordsRows } from "./processor/record_mapper";
import { pushToSheets } from "./sheets/push";
import { log } from "./utils/logger";

// ✏️ Adjust this window as needed for your demo
const DATE_START = "02/01/2026";
const DATE_END   = "02/07/2026";
const MAX_RECORDS = 50;
const OUTPUT_DIR  = "./downloads";

async function main() {
  console.log("=== Lien Automation Local Test ===");
  console.log(`Date range: ${DATE_START} → ${DATE_END}`);
  console.log(`Max records: ${MAX_RECORDS}\n`);

  const t0 = Date.now();

  // Stage 1: Scrape
  console.log("[1/4] Scraping CA SOS...");
  const rawRecords = await scrapeCASOS({
    date_start: DATE_START,
    date_end: DATE_END,
    max_records: MAX_RECORDS,
    output_dir: OUTPUT_DIR,
  });
  console.log(`      ✓ ${rawRecords.length} records scraped`);

  // Stage 2: Parse PDFs
  console.log("[2/4] Parsing PDFs for lien amounts...");
  const enriched = await parsePDFs(rawRecords, OUTPUT_DIR);
  const withAmount = enriched.filter(r => r.amount).length;
  console.log(`      ✓ ${withAmount}/${enriched.length} records have amount from PDF`);

  // Stage 3: Map to Records schema
  console.log("[3/4] Mapping to Records tab schema...");
  const rows = mapToRecordsRows(enriched);
  console.log(`      ✓ ${rows.length} rows mapped`);

  // Stage 4: Push to Sheets
  console.log("[4/4] Pushing to Google Sheets (Records tab)...");
  const result = await pushToSheets(rows);
  console.log(`      ✓ ${result.uploaded} rows uploaded`);

  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done in ${duration}s ===`);
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${process.env.SHEET_ID}`);

  // Print first 3 rows as preview
  if (rows.length > 0) {
    console.log("\nSample rows (first 3):");
    rows.slice(0, 3).forEach((row, i) => {
      console.log(`  [${i + 1}]`, JSON.stringify({
        site: row[0], date: row[1], amount: row[2],
        name: `${row[8]} ${row[9]}`.trim() || row[7],
        city: row[11], state: row[12],
      }));
    });
  }
}

main().catch(err => {
  console.error("FATAL:", err.message ?? err);
  process.exit(1);
});
