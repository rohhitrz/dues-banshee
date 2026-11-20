import { expect, test } from "@playwright/test";

// Requirements 1.3 and 6.4. /landing is public: a visitor with no session gets 200, not a redirect.
test.use({ storageState: { cookies: [], origins: [] } });

test("signed-out /landing returns 200 and its CTA reaches /signin", async ({ page }) => {
  const response = await page.goto("/landing");
  expect(response?.status()).toBe(200);

  await expect(
    page.getByRole("heading", { level: 1, name: "They forgot your invoice. The taxman won't." }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Enter the demo" }).click();
  await expect(page).toHaveURL(/\/signin$/);
});
