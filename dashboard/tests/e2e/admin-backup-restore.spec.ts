import { expect, test } from "@playwright/test";

test("admin backup & restore page renders", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "admin-1", username: "admin", isAdmin: true }),
    });
  });

  await page.goto("/dashboard/admin/backup");

  await expect(page).toHaveURL(/\/dashboard\/admin\/backup/);
  await expect(page.getByTestId("admin-backup-page")).toBeVisible();
  await expect(page.getByTestId("backup-title")).toBeVisible();
});

test("settings restore opens destructive confirmation dialog", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "admin-1", username: "admin", isAdmin: true }),
    });
  });

  await page.goto("/dashboard/admin/backup");

  await page.getByTestId("settings-restore-file").setInputFiles({
    name: "settings-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "settings",
        version: 1,
        exportedAt: "2026-04-14T12:00:00.000Z",
        sourceApp: "cliproxyapi-dashboard",
        payload: {
          systemSettings: [],
          modelPreferences: [],
          agentModelOverrides: [],
        },
      })
    ),
  });

  await page.getByTestId("open-settings-restore-confirm").click();

  await expect(page.getByRole("dialog")).toBeVisible();
});

test("credentials restore can render summary from API response", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "admin-1", username: "admin", isAdmin: true }),
    });
  });

  await page.route("**/api/admin/restore", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        result: {
          type: "providerCredentials",
          version: 1,
          summary: {
            providerKeys: { created: 2, updated: 1, skipped: 3, failed: 0 },
            providerOAuth: { created: 1, updated: 2, skipped: 0, failed: 1 },
          },
        },
      }),
    });
  });

  await page.goto("/dashboard/admin/backup");

  await page.getByTestId("credentials-restore-file").setInputFiles({
    name: "provider-credentials-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "provider-credentials",
        version: 1,
        exportedAt: "2026-04-14T12:00:00.000Z",
        sourceApp: "cliproxyapi-dashboard",
        payload: {
          providerKeys: [],
          providerOAuth: [],
        },
      })
    ),
  });

  await page.getByTestId("restore-credentials-backup").click();

  await expect(page.getByTestId("credentials-summary")).toBeVisible();
  await expect(page.getByTestId("credentials-summary")).toContainText("Created: 2");
  await expect(page.getByTestId("credentials-summary")).toContainText("Updated: 1");
  await expect(page.getByTestId("credentials-summary")).toContainText("Skipped: 3");
  await expect(page.getByTestId("credentials-summary")).toContainText("Failed: 0");
});
