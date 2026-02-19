import fs from "fs";
import path from "path";
// pdf-parse ships as CJS — must use require() for the callable default export
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text: string }>;
import { LienRecord } from "../types";
import { EnrichedRecord } from "./types";
import { log } from "../utils/logger";

/**
 * IRS Federal Tax Lien PDFs use varying formats for the lien amount.
 * These patterns cover the most common representations found in
 * NFTL (Notice of Federal Tax Lien) and UCC document bodies.
 */
const AMOUNT_PATTERNS: RegExp[] = [
  /total\s+amount\s+of\s+(?:liability|assessment)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  /unpaid\s+balance\s+of\s+assessment[s]?[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  /amount\s+of\s+(?:unpaid\s+)?(?:tax|liability)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  /balance\s+due[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  /total[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  /\$\s*([\d,]+\.\d{2})/,                          // last resort: first dollar amount in doc
];

function extractAmount(text: string): string {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      // Normalize: strip commas, reformat
      const num = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(num) && num > 0) {
        return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
    }
  }
  return "";
}

export async function parsePDFs(
  records: LienRecord[],
  outputDir = "./downloads"
): Promise<EnrichedRecord[]> {
  const enriched: EnrichedRecord[] = [];

  for (const record of records) {
    let amount = "";

    if (record.pdf_filename) {
      const pdfPath = path.join(outputDir, record.pdf_filename);

      if (fs.existsSync(pdfPath)) {
        try {
          const buffer = fs.readFileSync(pdfPath);
          const data = await pdfParse(buffer);
          amount = extractAmount(data.text);

          if (amount) {
            log({ stage: "pdf_amount_found", file_number: record.file_number, amount });
          } else {
            log({ stage: "pdf_amount_not_found", file_number: record.file_number });
          }
        } catch (err) {
          log({ stage: "pdf_parse_error", file_number: record.file_number, error: String(err) });
        }
      } else {
        log({ stage: "pdf_file_missing", file_number: record.file_number, expected_path: pdfPath });
      }
    }

    enriched.push({ ...record, amount });
  }

  return enriched;
}
