"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ca_sos_1 = require("./scraper/ca_sos");
const pdf_parser_1 = require("./processor/pdf_parser");
const record_mapper_1 = require("./processor/record_mapper");
const push_1 = require("./sheets/push");
const logger_1 = require("./utils/logger");
// ---------------------------------------------------------------------------
// Startup: validate required env vars before accepting any traffic
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ["SHEETS_KEY", "SHEET_ID"];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL: Missing required environment variable: ${key}`);
        process.exit(1);
    }
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
// ---------------------------------------------------------------------------
// Health check — required for Cloud Run and load balancer probes
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0", site: "ca_sos" });
});
// ---------------------------------------------------------------------------
// TooManyResults handler — recursively halve date range and merge results
// Max depth = 4 splits (so a 7-day window → 7 windows of ~12 hours)
// ---------------------------------------------------------------------------
function formatDate(d) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}
async function scrapeWithSplit(config, depth = 0) {
    const MAX_DEPTH = 4;
    try {
        return await (0, ca_sos_1.scrapeCASOS)(config);
    }
    catch (err) {
        if (err instanceof ca_sos_1.TooManyResultsError && depth < MAX_DEPTH) {
            const start = new Date(config.date_start);
            const end = new Date(config.date_end);
            const mid = new Date((start.getTime() + end.getTime()) / 2);
            const midStr = formatDate(mid);
            (0, logger_1.log)({ stage: "split_date_range", depth, from: config.date_start, to: config.date_end, mid: midStr });
            const [first, second] = await Promise.all([
                scrapeWithSplit({ ...config, date_end: midStr }, depth + 1),
                scrapeWithSplit({ ...config, date_start: midStr }, depth + 1),
            ]);
            return [...first, ...second];
        }
        throw err;
    }
}
// ---------------------------------------------------------------------------
// POST /scrape — main endpoint
// ---------------------------------------------------------------------------
app.post("/scrape", async (req, res) => {
    const startTime = Date.now();
    try {
        const { site, date_start, date_end, max_records } = req.body;
        if (!site || site !== "ca_sos") {
            return res.status(400).json({ error: "MVP supports only site: ca_sos" });
        }
        if (!date_start || !date_end) {
            return res.status(400).json({ error: "date_start and date_end are required (MM/DD/YYYY)" });
        }
        (0, logger_1.log)({ stage: "pipeline_start", site, date_start, date_end, max_records });
        // Stage 1: Scrape
        const rawRecords = await scrapeWithSplit({ date_start, date_end, max_records });
        (0, logger_1.log)({ stage: "scrape_done", count: rawRecords.length });
        // Stage 2: Parse PDFs for Amount
        const enriched = await (0, pdf_parser_1.parsePDFs)(rawRecords);
        (0, logger_1.log)({ stage: "pdf_parse_done", count: enriched.length });
        // Stage 3: Map to Records schema
        const rows = (0, record_mapper_1.mapToRecordsRows)(enriched);
        (0, logger_1.log)({ stage: "mapping_done", rows: rows.length });
        // Stage 4: Push to Sheets (Records tab)
        const sheetResult = await (0, push_1.pushToSheets)(rows);
        const duration = (Date.now() - startTime) / 1000;
        (0, logger_1.log)({ stage: "pipeline_complete", duration_seconds: duration, records: rawRecords.length, uploaded: sheetResult.uploaded });
        return res.json({
            success: true,
            records_scraped: rawRecords.length,
            rows_uploaded: sheetResult.uploaded,
            duration_seconds: duration,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.log)({ stage: "fatal_error", error: msg });
        return res.status(500).json({ success: false, error: msg });
    }
});
// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "8080", 10);
app.listen(PORT, () => {
    console.log(`Lien Automation server running on port ${PORT}`);
    console.log(`Sheet ID: ${process.env.SHEET_ID}`);
});
