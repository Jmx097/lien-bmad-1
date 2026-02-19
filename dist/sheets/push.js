"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushToSheets = pushToSheets;
const googleapis_1 = require("googleapis");
const record_mapper_1 = require("../processor/record_mapper");
const retry_1 = require("../utils/retry");
const logger_1 = require("../utils/logger");
const SHEET_TAB = "Records";
async function pushToSheets(rows) {
    if (!process.env.SHEETS_KEY)
        throw new Error("Missing SHEETS_KEY env var");
    if (!process.env.SHEET_ID)
        throw new Error("Missing SHEET_ID env var");
    const credentials = JSON.parse(process.env.SHEETS_KEY);
    const auth = new googleapis_1.google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = googleapis_1.google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.SHEET_ID;
    // Check if Records tab already has data (to avoid duplicate header rows)
    const existing = await (0, retry_1.withRetry)(() => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEET_TAB}!A1:A1`,
    }), 3, 1500);
    const hasHeader = (existing.data.values?.length ?? 0) > 0;
    const toWrite = hasHeader ? rows : [record_mapper_1.RECORDS_HEADERS, ...rows];
    if (toWrite.length === 0) {
        (0, logger_1.log)({ stage: "sheets_nothing_to_write" });
        return { uploaded: 0 };
    }
    await (0, retry_1.withRetry)(() => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: toWrite },
    }), 3, 1500);
    (0, logger_1.log)({ stage: "sheets_uploaded", tab: SHEET_TAB, rows: rows.length, headers_written: !hasHeader });
    return { uploaded: rows.length };
}
