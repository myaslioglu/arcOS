import { expect, test, type Page } from "@playwright/test";
import { USDC } from "@arcos/chain";

// Smoke checks against a production build: the desktop, its launcher and deep links in a real browser, and the two
// server-built routes a link preview or a README embed reaches. Selectors are the ones the shell renders
// (packages/shell/src/ui): a window is role="dialog" named by its title, the launcher is the dialog named "Search".

/**
 * Waits until the desktop has hydrated. The menu bar's clock reads "--:--" in the server's HTML and is set by an
 * effect, which runs in the same commit as the shell's keyboard and deep-link listeners, so once it shows the time,
 * a click or a key press is handled rather than lost.
 */
async function hydrated(page: Page) {
  await expect(page.locator(".os-clock")).not.toHaveText("--:--");
}

test.describe("desktop", () => {
  test("renders, and clicking a folder opens its window", async ({ page }) => {
    await page.goto("/");
    const desk = page.getByRole("group", { name: "Desktop" });
    await expect(desk).toBeVisible();
    await hydrated(page);

    await desk.getByRole("button", { name: /^Trust: / }).click();
    await expect(page.getByRole("dialog", { name: "Trust" })).toBeVisible();
  });

  test("Cmd/Ctrl+K opens the launcher, and picking an app opens its window", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.keyboard.press("ControlOrMeta+K");
    const launcher = page.getByRole("dialog", { name: "Search" });
    await expect(launcher).toBeVisible();
    const search = launcher.getByRole("combobox", { name: "Search" });
    await expect(search).toBeFocused();

    await search.fill("about");
    await search.press("Enter");
    await expect(launcher).toBeHidden();
    await expect(page.getByRole("dialog", { name: "About" })).toBeVisible();
  });

  test("/#app:about deep-links to the About window", async ({ page, baseURL }) => {
    await page.goto("/#app:about");
    const about = page.getByRole("dialog", { name: "About" });
    await expect(about).toBeVisible();
    // The window's body is loaded on demand; its first line proves it arrived.
    await expect(about.getByText("A desktop for Circle's Arc network", { exact: false })).toBeVisible();
    // The shell clears the hash once it has handled it, so the same link can be followed again.
    await expect(page).toHaveURL(`${baseURL}/`);
  });
});

test.describe("server-built routes", () => {
  // Both routes inspect the token on the chain at request time (RPC and explorer reads, under a 15 s deadline). The
  // cases below hold whether that reading succeeds or not: without the network the app answers the proof page's
  // degraded view and a neutral badge, both with a 200.
  test.setTimeout(45_000);

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("/t/<USDC> renders the proof page", async ({ page }) => {
      const response = await page.goto(`/t/${USDC}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByText("4rc.OS · proof page")).toBeVisible();
      // The report's heading (the token's name), or the degraded view's message when the chain couldn't be read.
      const report = page.getByRole("heading", { level: 1 });
      const degraded = page.getByText(/Couldn't read the chain for this token|busy reading other tokens/);
      await expect(report.or(degraded)).toBeVisible();
      await expect(page.getByRole("link", { name: "Open in 4rc.OS" })).toHaveAttribute(
        "href",
        `/#app:inspector?token=${USDC}`,
      );
      await expect(page.getByText("Automated analysis, not investment advice.", { exact: false })).toBeVisible();
    });
  });

  test("/badge/<USDC> answers an SVG image", async ({ request }) => {
    const response = await request.get(`/badge/${USDC}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\/svg\+xml\b/);
    expect(await response.text()).toMatch(/^<svg[\s>]/);
  });
});
