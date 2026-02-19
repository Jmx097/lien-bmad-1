import { google } from "googleapis";
import { RecordsRow } from "../processor/types";
import { RECORDS_HEADERS } from "../processor/record_mapper";
import { withRetry } from "../utils/retry";
import { log } from "../utils/logger";

const SHEET_TAB = "Records";

export async function pushToSheets(rows: RecordsRow[]): Promise<{ uploaded: number }> {
  if (!process.env.SHEETS_KEY) throw new Error("Missing SHEETS_KEY env var");
  if (!process.env.SHEET_ID) throw new Error("Missing SHEET_ID env var");

  const credentials = JSON.parse(process.env.SHEETS_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SHEET_ID;

  // Check if Records tab already has data (to avoid duplicate header rows)
  const existing = await withRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEET_TAB}!A1:A1`,
      }),
    3,
    1500
  );

  const hasHeader = (existing.data.values?.length ?? 0) > 0;
  const toWrite: RecordsRow[] = hasHeader ? rows : [RECORDS_HEADERS, ...rows];

  if (toWrite.length === 0) {
    log({ stage: "sheets_nothing_to_write" });
    return { uploaded: 0 };
  }

  await withRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: toWrite },
      }),
    3,
    1500
  );

  log({ stage: "sheets_uploaded", tab: SHEET_TAB, rows: rows.length, headers_written: !hasHeader });
  return { uploaded: rows.length };
}
