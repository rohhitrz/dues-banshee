import { expect, test } from "@playwright/test";
import { formatINR } from "@dues-banshee/engine";

// Requirement 10.8. Runs against a database holding the demo seed (see playwright.config.ts).
const TODAY = "2026-11-12";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOMBSTONE_HREF = new RegExp(`^/debtors/(${UUID})\\?today=${TODAY}#invoice-(${UUID})$`, "i");

test("graveyard tombstone opens the debtor page with the exact demo values", async ({ page }) => {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Enter the graveyard (demo)" }).click();
  await page.waitForURL((url) => url.pathname === "/");

  await page.goto(`/?today=${TODAY}`);
  // The Tombstone's accessible name is its aria-label: "<buyer>, <amount>, <n> days overdue, <state>".
  const tombstone = page.getByRole("link", { name: /^Sharma Traders,/ });
  await expect(tombstone).toHaveCount(1);

  const href = await tombstone.getAttribute("href");
  expect(href).not.toBeNull();
  const match = TOMBSTONE_HREF.exec(href ?? "");
  expect(match, `unexpected tombstone href: ${href}`).not.toBeNull();
  const [, buyerId, invoiceId] = match ?? [];

  await tombstone.click();
  await expect(page).toHaveURL(
    new RegExp(`/debtors/${buyerId}\\?today=${TODAY}#invoice-${invoiceId}$`, "i"),
  );

  await expect(page.getByRole("heading", { level: 1, name: "Sharma Traders" })).toBeVisible();

  const panel = page.locator(`#invoice-${invoiceId}`);
  await expect(panel.getByRole("heading", { level: 2, name: "LPC/26-27/0412" })).toBeVisible();
  await expect(panel.getByText(formatINR(41_200_000, "full"), { exact: true })).toBeVisible();
  await expect(panel.getByText("Overdue 26 days, interest accruing", { exact: true })).toBeVisible();
  await expect(panel).toContainText(formatINR(512_794, "full"));
  await expect(panel.getByText("Tax bomb armed: 139 days left to 31 March", { exact: true })).toBeVisible();
});
