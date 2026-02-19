import { chromium, Page, Locator } from "playwright";
import path from "path";
import fs from "fs";
import { limiter } from "../utils/rateLimit";
import { humanDelay } from "../utils/delay";
import { log } from "../utils/logger";
import { LienRecord } from "../types";

export interface ScrapeConfig {
  date_start: string;
  date_end: string;
  max_records?: number;
  output_dir?: string;
  resume_cursor?: {
    page: number;
    row_index: number;
  };
}

export class TooManyResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooManyResultsError";
  }
}

// ---------------------------------------------------------------------------
// Screenshot helper — saves to /app/ (Cloud Run) or CWD (local)
// ---------------------------------------------------------------------------
async function screenshot(page: Page, label: string): Promise<void> {
  try {
    const base = process.env.NODE_ENV === "production" ? "/app" : ".";
    const filepath = path.join(base, `debug-${label}-${Date.now()}.png`);
    await page.screenshot({ path: filepath, fullPage: true });
    log({ stage: "screenshot_saved", path: filepath, label });
  } catch (_) {
    // non-fatal — best effort
  }
}

// ---------------------------------------------------------------------------
// Safe text helper — never throws
// ---------------------------------------------------------------------------
async function safeText(locator: Locator): Promise<string> {
  try {
    return (await locator.textContent({ timeout: 3000 }))?.trim() ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// getField — multi-strategy label→value extraction
// Tries 4 different DOM patterns used by CA SOS BizFile
// ---------------------------------------------------------------------------
async function getField(page: Page, label: string): Promise<string> {
  const strategies: (() => Promise<string>)[] = [
    // Strategy 1: dt/dd pairs
    async () => {
      const dt = page.locator(`dt:has-text("${label}")`).first();
      if (await dt.isVisible({ timeout: 2000 }).catch(() => false)) {
        return (await dt.locator("+ dd").textContent({ timeout: 2000 }))?.trim() ?? "";
      }
      return "";
    },
    // Strategy 2: label sibling — text node adjacent sibling
    async () => {
      const el = page.locator(`*:has-text("${label}")`).last();
      const parent = el.locator("..");
      const children = parent.locator("*");
      const count = await children.count().catch(() => 0);
      for (let i = 0; i < count - 1; i++) {
        const text = await safeText(children.nth(i));
        if (text.includes(label)) {
          return safeText(children.nth(i + 1));
        }
      }
      return "";
    },
    // Strategy 3: data-label attribute
    async () => {
      const el = page.locator(`[data-label="${label}"]`).first();
      return safeText(el);
    },
    // Strategy 4: th→td in a table row
    async () => {
      const th = page.locator(`th:has-text("${label}")`).first();
      if (await th.isVisible({ timeout: 2000 }).catch(() => false)) {
        return safeText(th.locator("~ td").first());
      }
      return "";
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result) return result;
    } catch {
      // try next
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------
export async function scrapeCASOS(config: ScrapeConfig): Promise<LienRecord[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  const outputDir = config.output_dir ?? "./downloads";
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const records: LienRecord[] = [];
  let totalCollected = 0;
  const maxRecords = config.max_records ?? 1000;
  const { page: startPage, row_index: startRow } =
    config.resume_cursor ?? { page: 1, row_index: 0 };

  try {
    log({ stage: "navigate", url: "https://bizfileonline.sos.ca.gov/search/ucc" });

    await limiter.schedule(() =>
      page.goto("https://bizfileonline.sos.ca.gov/search/ucc", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
    );

    await humanDelay(1000, 2000);

    // -----------------------------------------------------------------------
    // Search input — try multiple selectors in order
    // -----------------------------------------------------------------------
    const searchSelectors = [
      "input[aria-label*='name' i]",
      "input[aria-label*='search' i]",
      "input[placeholder*='name' i]",
      "input[placeholder*='search' i]",
      ".search-bar input[type='text']",
      "input[type='search']",
      "input[type='text']",
    ];

    let searchInput: Locator | null = null;
    for (const sel of searchSelectors) {
      const candidate = page.locator(sel).first();
      if (await candidate.isVisible({ timeout: 5000 }).catch(() => false)) {
        searchInput = candidate;
        log({ stage: "search_input_found", selector: sel });
        break;
      }
    }

    if (!searchInput) {
      await screenshot(page, "no-search-input");
      throw new Error("Could not find search input on CA SOS UCC page");
    }

    log({ stage: "fill_search" });
    await searchInput.fill("Internal Revenue Service");
    await humanDelay();

    // -----------------------------------------------------------------------
    // Advanced search toggle
    // -----------------------------------------------------------------------
    const advancedSelectors = [
      page.getByRole("button", { name: /Advanced/i }),
      page.getByText(/Advanced Search/i),
      page.locator("a:has-text('Advanced')"),
      page.locator("[aria-label*='Advanced' i]"),
    ];

    let advancedClicked = false;
    for (const el of advancedSelectors) {
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click();
        advancedClicked = true;
        log({ stage: "advanced_clicked" });
        break;
      }
    }

    if (!advancedClicked) {
      await screenshot(page, "no-advanced-btn");
      log({ stage: "advanced_btn_not_found", note: "proceeding without advanced filter" });
    }

    await humanDelay(800, 1500);

    // -----------------------------------------------------------------------
    // File Type dropdown — try label and aria
    // -----------------------------------------------------------------------
    const fileTypeSelectors = [
      page.getByLabel("File Type"),
      page.locator("select[name*='fileType' i]"),
      page.locator("select[aria-label*='type' i]"),
      page.locator("select").first(),
    ];

    for (const sel of fileTypeSelectors) {
      try {
        if (await sel.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sel.selectOption({ label: "Federal Tax Lien" });
          log({ stage: "file_type_selected" });
          break;
        }
      } catch {
        // try next
      }
    }

    await humanDelay();

    // -----------------------------------------------------------------------
    // Date range — try label and placeholder
    // -----------------------------------------------------------------------
    const startDateSelectors = [
      page.getByLabel("File Date: Start"),
      page.getByLabel(/start date/i),
      page.locator("input[placeholder*='start' i]").first(),
      page.locator("input[type='date']").first(),
    ];

    const endDateSelectors = [
      page.getByLabel("File Date: End"),
      page.getByLabel(/end date/i),
      page.locator("input[placeholder*='end' i]").first(),
      page.locator("input[type='date']").last(),
    ];

    for (const sel of startDateSelectors) {
      try {
        if (await sel.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sel.fill(config.date_start);
          log({ stage: "date_start_filled", value: config.date_start });
          break;
        }
      } catch { /* try next */ }
    }

    for (const sel of endDateSelectors) {
      try {
        if (await sel.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sel.fill(config.date_end);
          await sel.press("Tab");
          log({ stage: "date_end_filled", value: config.date_end });
          break;
        }
      } catch { /* try next */ }
    }

    await humanDelay();

    // -----------------------------------------------------------------------
    // Submit search
    // -----------------------------------------------------------------------
    log({ stage: "submit_search" });
    await screenshot(page, "pre-submit");

    const searchBtn = page.getByRole("button", { name: /^Search$/i });
    await searchBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await humanDelay(1500, 2500);

    await screenshot(page, "post-submit");

    // -----------------------------------------------------------------------
    // Result count
    // -----------------------------------------------------------------------
    let totalCount = 0;
    try {
      const resultLocator = page.locator("text=/Results:\\s*\\d+/").first();
      await resultLocator.waitFor({ state: "visible", timeout: 15000 });
      const resultText = (await resultLocator.textContent()) ?? "";
      totalCount = parseInt(resultText.match(/\d+/)?.[0] ?? "0", 10);
    } catch {
      // Maybe the results text format differs — try counting table rows
      const rowCount = await page.locator("table tbody tr").count().catch(() => 0);
      totalCount = rowCount;
      log({ stage: "result_count_fallback", row_count: rowCount });
    }

    log({ stage: "results_found", total: totalCount });

    if (totalCount > 1000) {
      throw new TooManyResultsError(
        `Search returned ${totalCount} results for ${config.date_start}–${config.date_end}. Splitting date range.`
      );
    }
    if (totalCount === 0) {
      log({ stage: "no_results" });
      return [];
    }

    // Navigate to resume page if needed
    if (startPage > 1) {
      await page.getByRole("button", { name: String(startPage) }).click();
      await page.waitForLoadState("domcontentloaded");
    }

    let currentPage = startPage;
    let hasNextPage = true;

    while (hasNextPage && totalCollected < maxRecords) {
      const rows = page.locator("table tbody tr");
      const rowCount = await rows.count();
      const rowStart = currentPage === startPage ? startRow : 0;

      log({ stage: "page_start", currentPage, rowCount });

      for (let i = rowStart; i < rowCount; i++) {
        if (totalCollected >= maxRecords) {
          hasNextPage = false;
          break;
        }

        try {
          const record = await processRow(page, rows.nth(i), i, currentPage, outputDir);
          if (record) {
            records.push(record);
            totalCollected++;
            log({
              stage: "record_collected",
              total: totalCollected,
              file_number: record.file_number,
              processed: record.processed,
              error: record.error,
            });
          }
        } catch (rowErr) {
          log({ stage: "row_skipped", row: i, page: currentPage, error: String(rowErr) });
        }
      }

      const nextBtn = page.getByRole("button", { name: "Next Page" });
      const nextVisible = await nextBtn.isVisible().catch(() => false);
      if (nextVisible && totalCollected < maxRecords) {
        await nextBtn.click();
        await page.waitForLoadState("domcontentloaded");
        await humanDelay();
        currentPage++;
      } else {
        hasNextPage = false;
      }
    }

    log({ stage: "scrape_done", total_collected: totalCollected });
    return records;

  } catch (err) {
    log({ stage: "scraper_error", error: String(err) });
    await screenshot(page, "fatal-error");
    throw err;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// processRow — extract data from one result table row
// ---------------------------------------------------------------------------
async function processRow(
  page: Page,
  row: Locator,
  rowIndex: number,
  pageNum: number,
  outputDir: string
): Promise<LienRecord | null> {

  const cells = row.locator("td");
  const ucc_type    = (await safeText(cells.nth(0)));
  const file_number = (await safeText(cells.nth(2)));
  const status      = (await safeText(cells.nth(4)));
  const filing_date = (await safeText(cells.nth(5)));
  const lapse_date  = (await safeText(cells.nth(6)));

  if (!file_number) return null;

  // -----------------------------------------------------------------------
  // Open detail panel via chevron/expand button
  // -----------------------------------------------------------------------
  const chevronSelectors = [
    row.locator("button[aria-label*='expand' i]").first(),
    row.locator("button[aria-label*='detail' i]").first(),
    row.locator("button").first(),
  ];

  let panelOpened = false;
  for (const chevron of chevronSelectors) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chevron.click({ timeout: 5000 });
        await page
          .locator('[class*="detail"], [class*="panel"], [class*="expand"], [role="region"]')
          .filter({ hasText: file_number })
          .first()
          .waitFor({ state: "visible", timeout: 8000 });
        panelOpened = true;
        break;
      } catch {
        if (attempt === 0) await humanDelay(500, 1000);
      }
    }
    if (panelOpened) break;
  }

  if (!panelOpened) {
    await screenshot(page, `panel-failed-${file_number}`);
    log({ stage: "panel_failed", file_number, pageNum, rowIndex });
    return buildRecord({ ucc_type, file_number, status, filing_date, lapse_date, error: "panel_failed" });
  }

  // -----------------------------------------------------------------------
  // Extract detail panel fields
  // -----------------------------------------------------------------------
  const debtor_name           = await getField(page, "Debtor Name");
  const debtor_address        = await getField(page, "Debtor Address");
  const secured_party_name    = await getField(page, "Secured Party Name");
  const secured_party_address = await getField(page, "Secured Party Address");

  // -----------------------------------------------------------------------
  // Open History modal
  // -----------------------------------------------------------------------
  const historyBtnSelectors = [
    page.getByRole("button", { name: /View History/i }),
    page.getByRole("button", { name: /History/i }),
    page.locator("button:has-text('History')"),
  ];

  let historyOpened = false;
  for (const btn of historyBtnSelectors) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await btn.click({ timeout: 5000 });
        await page.getByRole("dialog").filter({ hasText: /History/i }).first().waitFor({ state: "visible", timeout: 8000 });
        historyOpened = true;
        break;
      } catch {
        if (attempt === 0) await humanDelay(500, 1000);
      }
    }
    if (historyOpened) break;
  }

  if (!historyOpened) {
    await screenshot(page, `history-failed-${file_number}`);
    log({ stage: "history_failed", file_number });
    await closePanel(page);
    return buildRecord({ ucc_type, file_number, status, filing_date, lapse_date, debtor_name, debtor_address, secured_party_name, secured_party_address, error: "history_failed" });
  }

  // -----------------------------------------------------------------------
  // Extract document type + download PDF
  // -----------------------------------------------------------------------
  const modal = page.getByRole("dialog").filter({ hasText: /History/i }).first();
  const document_type = (await safeText(
    modal.locator("text=Document Type").locator("..").locator("+ *").first()
  )) || (await getField(page, "Document Type"));

  let pdf_filename = "";
  const downloadLink = modal.getByRole("link", { name: /Download/i }).first();
  const linkExists = await downloadLink.isVisible({ timeout: 3000 }).catch(() => false);

  if (linkExists) {
    try {
      const safeDate = filing_date.replace(/\//g, "");
      pdf_filename = `${file_number}_${safeDate}.pdf`;
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        downloadLink.click(),
      ]);
      await download.saveAs(path.join(outputDir, pdf_filename));
      log({ stage: "pdf_downloaded", file_number, pdf_filename });
    } catch (err) {
      log({ stage: "pdf_download_failed", file_number, error: String(err) });
      pdf_filename = "";
    }
  } else {
    log({ stage: "no_download_available", file_number });
  }

  // Close modal then panel
  try {
    await modal.getByRole("button", { name: /close|×|✕/i }).first().click();
    await modal.waitFor({ state: "hidden", timeout: 5000 });
  } catch {
    await page.keyboard.press("Escape");
  }
  await closePanel(page);

  return buildRecord({
    ucc_type, file_number, status, filing_date, lapse_date,
    debtor_name, debtor_address, secured_party_name, secured_party_address,
    document_type, pdf_filename,
    processed: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function closePanel(page: Page): Promise<void> {
  try {
    const closeBtn = page.locator('[aria-label="Close"], button:has-text("×"), button:has-text("✕")').last();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(400);
  } catch {
    await page.keyboard.press("Escape");
  }
}

function buildRecord(fields: Partial<LienRecord> & { file_number: string }): LienRecord {
  return {
    state: "CA",
    ucc_type: fields.ucc_type ?? "",
    debtor_name: fields.debtor_name ?? "",
    debtor_address: fields.debtor_address ?? "",
    file_number: fields.file_number,
    secured_party_name: fields.secured_party_name ?? "",
    secured_party_address: fields.secured_party_address ?? "",
    status: fields.status ?? "",
    filing_date: fields.filing_date ?? "",
    lapse_date: fields.lapse_date ?? "",
    document_type: fields.document_type ?? "",
    pdf_filename: fields.pdf_filename ?? "",
    processed: fields.processed ?? false,
    error: fields.error,
  };
}
