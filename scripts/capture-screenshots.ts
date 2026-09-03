/**
 * Regenerate the README screenshots.
 *
 * Drives a real browser against a running dev server and writes the images the
 * README references. Kept as a script rather than a manual chore so the gallery
 * can be refreshed after a UI change without anyone having to remember what to
 * capture, in what order, or at what size.
 *
 * ## Two passes, on purpose
 *
 * The decision screenshots are captured in **live** mode, so they carry the
 * `LIVE T3N` badge and show real consent state — that is the whole point of the
 * project and a fixture screenshot would undersell it. Only the DENIED case
 * comes from **demo** mode, because the live seeded subject has no failed
 * verification to show.
 *
 * Run it twice:
 *
 *   npm run dev                                    # CLAIM_SOURCE=live in .env
 *   CAPTURE_MODE=live npx tsx scripts/capture-screenshots.ts
 *
 *   CLAIM_SOURCE=demo npm run dev                  # restart in demo mode
 *   CAPTURE_MODE=demo npx tsx scripts/capture-screenshots.ts
 *
 * Playwright is intentionally NOT a dependency of this project — it is heavy for
 * a repo that keeps its dependency list short. Install it only when
 * regenerating, then remove it:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm uninstall playwright
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const BASE = process.env.CAPTURE_URL ?? "http://localhost:5173";
const MODE = (process.env.CAPTURE_MODE ?? "live").toLowerCase();
const OUT = resolve(process.cwd(), "docs/screenshots");

/** Wide enough that no table needs horizontal scroll. */
const WIDTH = 1440;

async function nav(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(900);
}

async function shot(page: Page, file: string, height: number): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height });
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(OUT, file) });
  console.log(`  ✓ ${file}`);
}

/** Fail loudly rather than saving a screenshot of an error state. */
async function expectDecision(page: Page, expected: string): Promise<void> {
  const banner = page.locator("h1", { hasText: expected });
  await banner.waitFor({ state: "visible", timeout: 15_000 });
}

async function evaluate(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Evaluate request/i }).click();
  await page.waitForTimeout(2000);
}

/** Live pass: drive the real seeded T3N subject. */
async function captureLive(page: Page): Promise<void> {
  await shot(page, "01-dashboard.png", 900);

  // APPROVED — employee_dashboard / read, both scopes consented
  await nav(page, "New request");
  await page.getByRole("button", { name: /Use this subject/i }).click();
  await page.waitForTimeout(400);
  await page.locator("select").nth(2).selectOption("employee_dashboard");
  await page.locator("select").nth(1).selectOption("read");
  await evaluate(page);
  await expectDecision(page, "Approved");
  await shot(page, "03-approved.png", 1550);

  // REVIEW_REQUIRED — production_database / admin, training scope withheld
  await page.locator("select").nth(2).selectOption("production_database");
  await page.locator("select").nth(1).selectOption("admin");
  await evaluate(page);
  await expectDecision(page, "Review required");
  await shot(page, "04-review-required.png", 1650);

  // Audit log, with a row expanded to reveal the salted subject hash
  await nav(page, "Audit log");
  await page.locator("tbody tr").first().click();
  await page.waitForTimeout(800);
  await shot(page, "06-audit-log.png", 1000);

  await nav(page, "Policies");
  await shot(page, "07-policies.png", 1500);

  await nav(page, "T3N status");
  await shot(page, "08-t3n-status.png", 950);
}

/** Demo pass: the scenario cards, and the one outcome live data cannot show. */
async function captureDemo(page: Page): Promise<void> {
  await nav(page, "New request");
  await shot(page, "02-new-request.png", 1000);

  // DENIED — a contractor whose company verification explicitly failed
  await page.getByText("C — Failed company verification", { exact: false }).first().click();
  await page.waitForTimeout(400);
  await evaluate(page);
  await expectDecision(page, "Denied");
  await shot(page, "05-denied.png", 1550);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 1000 },
    deviceScaleFactor: 2, // retina-sharp on GitHub
  });

  console.log(`capturing (${MODE}) from ${BASE} → docs/screenshots/`);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);

  if (MODE === "demo") await captureDemo(page);
  else await captureLive(page);

  await browser.close();
  console.log("done");
}

main().catch((err: unknown) => {
  console.error("capture failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
