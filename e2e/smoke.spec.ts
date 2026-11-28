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

  test("the Trade folder's Meme tile is tagged Soon, and opens a window that says so", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.getByRole("group", { name: "Desktop" }).getByRole("button", { name: /^Trade: / }).click();
    const trade = page.getByRole("dialog", { name: "Trade" });
    const tile = trade.getByRole("button", { name: "Meme, soon" });
    await expect(tile).toBeEnabled();
    await expect(tile.locator(".os-soon")).toHaveText("Soon");
    await tile.click();
    const meme = page.getByRole("dialog", { name: "Meme" });
    await expect(meme).toBeVisible();
    await expect(meme.getByText("Soon.", { exact: true })).toBeVisible();
  });

  // The e2e build is mainnet without K_SERVICE, so /api/radar answers 503 and the window shows its first-load error;
  // the filters and the note are there in every state, and that is what this checks.
  test("the Trade folder's Radar tile opens Radar with its filters and its note", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.getByRole("group", { name: "Desktop" }).getByRole("button", { name: /^Trade: / }).click();
    const trade = page.getByRole("dialog", { name: "Trade" });
    const tile = trade.getByRole("button", { name: "Radar", exact: true });
    await expect(tile).toBeEnabled();
    await expect(tile.locator(".os-soon")).toHaveCount(0);
    await tile.click();
    const radar = page.getByRole("dialog", { name: "Radar" });
    await expect(radar).toBeVisible();
    await expect(radar.getByRole("checkbox", { name: "Has liquidity" })).toBeVisible();
    await expect(radar.getByRole("checkbox", { name: "At least 5 checks pass" })).toBeVisible();
    await expect(radar.getByText("evidence, never a score", { exact: false })).toBeVisible();
  });

  // The e2e build is mainnet without K_SERVICE, so /api/stats answers 503 and the window shows its first-load error. The
  // System folder lists Stats beside About and the rest, with no "Soon" tag, and the window says what it can't read.
  test("the System folder's Stats tile opens Stats, which says when the counts can't be read", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.getByRole("group", { name: "Desktop" }).getByRole("button", { name: /^System: / }).click();
    const system = page.getByRole("dialog", { name: "System" });
    const tile = system.getByRole("button", { name: "Stats", exact: true });
    await expect(tile).toBeEnabled();
    await expect(tile.locator(".os-soon")).toHaveCount(0);
    await tile.click();
    const stats = page.getByRole("dialog", { name: "Stats" });
    await expect(stats).toBeVisible();
    await expect(stats.getByText("The usage counts can't be read right now.", { exact: false })).toBeVisible();
    await expect(stats.getByRole("button", { name: "Try again" })).toBeVisible();
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

  // Watchdog needs a connected, signed-in wallet, and the browser here has none: the window opens on its connect
  // prompt, which is ConnectGate's, and that proves the app is live (a grey app would open its "work in progress" window).
  test("/#app:watchdog deep-links to the Watchdog window, which asks for a wallet", async ({ page }) => {
    await page.goto("/#app:watchdog");
    const watchdog = page.getByRole("dialog", { name: "Watchdog" });
    await expect(watchdog).toBeVisible();
    await expect(watchdog.getByText("Connect a wallet to use this app.", { exact: true })).toBeVisible();
    await expect(watchdog.getByRole("button", { name: "Open Wallet" })).toBeVisible();
    await expect(watchdog.getByText("work in progress", { exact: false })).toHaveCount(0);
  });

  // Vault acts through the VaultFactory, which no network's ARCOS names yet (D6 of the R1/R2 design): the build lists its
  // grey stand-in, and a deep link opens the "work in progress" window, never the live app's wallet prompt.
  test("/#app:vault opens Vault's work-in-progress window while no VaultFactory is set", async ({ page }) => {
    await page.goto("/#app:vault");
    const vault = page.getByRole("dialog", { name: "Vault" });
    await expect(vault).toBeVisible();
    await expect(
      vault.getByText("Will lock tokens or liquidity until a date you choose, so they can't be withdrawn early, not even by the owner.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(vault.getByText("Connect a wallet to use this app.", { exact: true })).toHaveCount(0);
  });

  // Help stands at the top of the desk's last column. Its guide lists this site's apps from the registry: on this
  // mainnet build Vault is the grey stand-in, so its card says it comes after the audit and opens the stand-in's window.
  test("the desk's Help item opens the guide, which lists the apps and opens them", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.getByRole("group", { name: "Desktop" }).getByRole("button", { name: /^Help: / }).click();
    const help = page.getByRole("dialog", { name: "Help" });
    await expect(help).toBeVisible();
    await expect(help.getByRole("heading", { level: 2, name: "What is ArcOS?" })).toBeVisible();
    for (const name of ["Get started", "What can I do here?", "Protect your wallet", "Words to know"]) {
      await expect(help.getByRole("heading", { level: 2, name })).toBeAttached();
    }

    await help.getByRole("navigation", { name: "Help sections" }).getByRole("button", { name: "Apps" }).click();
    await expect(help.getByRole("heading", { level: 2, name: "What can I do here?" })).toBeFocused();
    const vault = help.locator('li[data-app="vault"]');
    await expect(vault.getByText("Soon: after the audit", { exact: true })).toBeVisible();
    await expect(help.locator('li[data-app="meme"]')).toHaveCount(0);

    await help.locator('li[data-app="inspector"]').getByRole("button", { name: "Open Inspector" }).click();
    await expect(page.getByRole("dialog", { name: "Inspector" })).toBeVisible();
  });

  test("the menu bar's Help menu opens the guide", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);

    await page.getByRole("navigation", { name: "menu bar" }).getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("menuitem", { name: "ArcOS Help" }).click();
    await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
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

// The suite runs against the mainnet build (ci.yml builds with apps/web/apphosting.yaml). The testnet site's label and
// noindex must not reach it: the title, the menu bar, the robots meta tag and the X-Robots-Tag header are as before.
test.describe("the mainnet build", () => {
  test("has no Testnet label and no noindex", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["x-robots-tag"]).toBeUndefined();
    await hydrated(page);
    await expect(page).toHaveTitle("ArcOS");
    await expect(page.locator(".os-network-badge")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "ArcOS", exact: true })).toBeAttached();
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
      await expect(page.getByText("ArcOS · proof page")).toBeVisible();
      // The report's heading (the token's name), or the degraded view's message when the chain couldn't be read.
      const report = page.getByRole("heading", { level: 1 });
      const degraded = page.getByText(/Couldn't read the chain for this token|busy reading other tokens/);
      await expect(report.or(degraded)).toBeVisible();
      await expect(page.getByRole("link", { name: "Open in ArcOS" })).toHaveAttribute(
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
    expect(await response.text()).toMatch(/<svg[\s>]/); // an XML prolog may come first
  });

  test("/t/<USDC> names a social card that answers a PNG", async ({ page, request }) => {
    await page.goto(`/t/${USDC}`);
    const card = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(card).toBeTruthy();
    const response = await request.get(new URL(card!).pathname + new URL(card!).search);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });
});

// The chain form of the routes, /<route>/<chain>/<address>. Arc's slug there is sent to the bare address for good. Every
// other chain answers only where NEXT_PUBLIC_INSPECT_CHAINS (read from the same apphosting.yaml as the build) switches it
// on, and 404 everywhere else: the suite checks whichever this build is.
test.describe("the chain routes", () => {
  test.setTimeout(45_000);
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const enabled = new Set((process.env.NEXT_PUBLIC_INSPECT_CHAINS ?? "").split(",").map((s) => s.trim()));

  for (const route of ["t", "badge", "api/inspect"]) {
    test(`/${route}/arc/<USDC> redirects for good to /${route}/<USDC>`, async ({ request }) => {
      const response = await request.get(`/${route}/arc/${USDC}`, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers()["location"]).toBe(`/${route}/${USDC}`);
    });
  }

  test("/t/base/<Base USDC> renders a report or the degraded view where Base is on, and 404 where it isn't", async ({ page }) => {
    const response = await page.goto(`/t/base/${BASE_USDC}`);
    if (!enabled.has("base")) {
      expect(response?.status()).toBe(404);
      return;
    }
    expect(response?.status()).toBe(200);
    await expect(page.getByText("ArcOS · proof page")).toBeVisible();
    const report = page.getByRole("heading", { level: 1 });
    const degraded = page.getByText(/Couldn't read the chain for this token|busy reading other tokens/);
    await expect(report.or(degraded)).toBeVisible();
  });

  test("/badge/ethereum/<USDC> is an SVG where Ethereum is on, and 404 where it isn't", async ({ request }) => {
    const response = await request.get(`/badge/ethereum/${ETHEREUM_USDC}`);
    if (!enabled.has("ethereum")) {
      expect(response.status()).toBe(404);
      return;
    }
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\/svg\+xml\b/);
  });

  test("/#app:inspector has a Chain picker where another chain is on, and none where none is", async ({ page }) => {
    await page.goto("/#app:inspector");
    const win = page.getByRole("dialog", { name: "Inspector" });
    await expect(win).toBeVisible();
    const picker = win.getByRole("combobox", { name: "Chain" });
    if ([...enabled].every((slug) => slug === "" || slug === "arc")) {
      await expect(picker).toHaveCount(0);
      return;
    }
    await expect(picker).toBeVisible();
    await expect(picker.locator("option").first()).toHaveText("Arc");
  });

  test("/#app:inspector?chain=base reads Base through the site's server where Base is on, and says it isn't where it isn't", async ({ page }) => {
    await page.goto(`/#app:inspector?chain=base&token=${BASE_USDC}`);
    const win = page.getByRole("dialog", { name: /^Inspector/ });
    await expect(win).toBeVisible();
    if (!enabled.has("base")) {
      await expect(win.getByText("Inspector doesn't read Base on this site.")).toBeVisible();
      return;
    }
    // The server reads the chain when the test runs; a read that fails still shows one of the window's own messages.
    const report = win.getByText("Open on Basescan");
    const refused = win.getByText(/Inspector is busy|Too many requests|Couldn't reach the network|Couldn't read the report/);
    await expect(report.or(refused)).toBeVisible({ timeout: 30_000 });
  });

  test("/api/inspect/<chain>/<address> answers 404 for a chain the site doesn't read", async ({ request }) => {
    const response = await request.get(`/api/inspect/polygon/${ETHEREUM_USDC}`);
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: "Not available on this network." });
  });
});
