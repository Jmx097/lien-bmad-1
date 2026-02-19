"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const ca_sos_1 = require("./scraper/ca_sos");
const pdf_parser_1 = require("./processor/pdf_parser");
const record_mapper_1 = require("./processor/record_mapper");
const push_1 = require("./sheets/push");
// ✏️ Adjust this window as needed for your demo
const DATE_START = "02/01/2026";
const DATE_END = "02/07/2026";
const MAX_RECORDS = 50;
const OUTPUT_DIR = "./downloads";
async function main() {
    console.log("=== Lien Automation Local Test ===");
    console.log(`Date range: ${DATE_START} → ${DATE_END}`);
    console.log(`Max records: ${MAX_RECORDS}\n`);
    const t0 = Date.now();
    // Stage 1: Scrape
    console.log("[1/4] Scraping CA SOS...");
    const rawRecords = await (0, ca_sos_1.scrapeCASOS)({
        date_start: DATE_START,
        date_end: DATE_END,
        max_records: MAX_RECORDS,
        output_dir: OUTPUT_DIR,
    });
    console.log(`      ✓ ${rawRecords.length} records scraped`);
    // Stage 2: Parse PDFs
    console.log("[2/4] Parsing PDFs for lien amounts...");
    const enriched = await (0, pdf_parser_1.parsePDFs)(rawRecords, OUTPUT_DIR);
    const withAmount = enriched.filter(r => r.amount).length;
    console.log(`      ✓ ${withAmount}/${enriched.length} records have amount from PDF`);
    // Stage 3: Map to Records schema
    console.log("[3/4] Mapping to Records tab schema...");
    const rows = (0, record_mapper_1.mapToRecordsRows)(enriched);
    console.log(`      ✓ ${rows.length} rows mapped`);
    // Stage 4: Push to Sheets
    console.log("[4/4] Pushing to Google Sheets (Records tab)...");
    const result = await (0, push_1.pushToSheets)(rows);
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
