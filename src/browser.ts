import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright-core";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { diffSnapshots } from "./snapshot.js";
import { ACTION_SETTLE, NAVIGATION_SETTLE, runAndSettle } from "./settle.js";
import { CHROME_OWNER_ARG, startChromeWatchdog } from "./watchdog.js";

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultValue?: string;
  timestamp: number;
}

export interface LocateOptions {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  exact?: boolean;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<{ browser: Browser; context: BrowserContext }> | null = null;
  private tabs: Map<string, Page> = new Map();
  private pageToId: Map<Page, string> = new Map();
  private activeTabId: string | null = null;
  private tabCounter = 0;
  private lastDialog: DialogInfo | null = null;
  // The last snapshot returned to the model for each page; incremental snapshots diff against it.
  private snapshotBaselines = new WeakMap<Page, { yaml: string; url: string }>();

  private registerPage(page: Page): string {
    const existing = this.pageToId.get(page);
    if (existing) return existing;

    const id = `tab-${++this.tabCounter}`;
    this.tabs.set(id, page);
    this.pageToId.set(page, id);
    this.activeTabId = id;

    // Auto-handle JavaScript dialogs (alert, confirm, prompt, beforeunload)
    page.on("dialog", async (dialog) => {
      this.lastDialog = {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        timestamp: Date.now(),
      };
      await dialog.accept().catch(() => {});
    });

    page.on("close", () => {
      this.tabs.delete(id);
      this.pageToId.delete(page);
      if (this.activeTabId === id) {
        const remaining = Array.from(this.tabs.keys());
        this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
    });

    return id;
  }

  private detectProxy(): string | undefined {
    if (process.env.BROWSER_PROXY) return process.env.BROWSER_PROXY;
    if (process.env.HTTPS_PROXY) return process.env.HTTPS_PROXY;
    if (process.env.HTTP_PROXY) return process.env.HTTP_PROXY;
    if (process.env.ALL_PROXY) return process.env.ALL_PROXY;

    if (process.platform === "darwin") {
      try {
        const out = execSync("scutil --proxy", { encoding: "utf8" });
        const httpEnable = out.includes("HTTPEnable : 1");
        const portMatch = out.match(/HTTPPort\s*:\s*(\d+)/);
        const hostMatch = out.match(/HTTPProxy\s*:\s*([^\s]+)/);
        if (httpEnable && portMatch && hostMatch) {
          return `http://${hostMatch[1]}:${portMatch[1]}`;
        }
      } catch {}
    }
    return undefined;
  }

  private findChromeExecutable(): string | undefined {
    const candidates = [
      process.env.CHROME_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];

    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  public async getBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.browser && this.context) {
      return { browser: this.browser, context: this.context };
    }
    // Concurrent callers share one launch; otherwise each would start its own Chrome and
    // all but the last would be left running unreferenced.
    this.launching ??= this.launchBrowser().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    const executablePath = this.findChromeExecutable();
    const headless = process.env.BROWSER_HEADLESS === "true";

    const launchOptions: any = {
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--no-first-run",
        CHROME_OWNER_ARG,
      ],
    };
    if (executablePath) {
      launchOptions.executablePath = executablePath;
    } else {
      launchOptions.channel = "chrome";
    }

    const proxy = this.detectProxy();
    if (proxy) {
      launchOptions.proxy = {
        server: proxy,
        bypass: "<-loopback>,localhost,127.0.0.1",
      };
    }

    const browser = await chromium.launch(launchOptions);
    const stopWatchdog = startChromeWatchdog();
    // Chrome quit or crashed (or closeAll closed it): drop the dead handles so the next call
    // launches a fresh browser instead of failing with "Target closed" from then on.
    browser.on("disconnected", () => {
      stopWatchdog();
      if (this.browser === browser) this.resetState();
    });

    let context: BrowserContext;
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
    } catch (err) {
      // Nothing else holds this browser yet, so it must be closed here or it leaks.
      await browser.close().catch(() => {});
      throw err;
    }

    // Listen for popup / new tabs and auto-focus
    context.on("page", (newPage) => {
      const id = this.registerPage(newPage);
      this.activeTabId = id;
    });

    this.browser = browser;
    this.context = context;
    return { browser, context };
  }

  public async getActivePage(): Promise<{ page: Page; tabId: string }> {
    await this.getBrowser();

    if (!this.activeTabId || !this.tabs.has(this.activeTabId)) {
      const page = await this.context!.newPage();
      const tabId = this.registerPage(page);
      return { page, tabId };
    }

    const page = this.tabs.get(this.activeTabId)!;
    return { page, tabId: this.activeTabId };
  }

  public async open(url: string, newTab = false): Promise<{ page: Page; tabId: string; snapshot: string }> {
    await this.getBrowser();

    let page: Page | null = null;
    let tabId: string | null = null;

    // Reuse an existing tab on the same origin instead of piling up new ones.
    if (!newTab && this.tabs.size > 0) {
      let targetOrigin: string | null = null;
      try {
        targetOrigin = new URL(url).origin;
      } catch {}

      if (targetOrigin) {
        for (const [id, p] of this.tabs.entries()) {
          try {
            if (new URL(p.url()).origin === targetOrigin) {
              page = p;
              tabId = id;
              this.activeTabId = id;
              break;
            }
          } catch {}
        }
      }
    }

    if (!page || !tabId) {
      if (newTab || this.tabs.size === 0) {
        page = await this.context!.newPage();
        tabId = this.registerPage(page);
      } else {
        const active = await this.getActivePage();
        page = active.page;
        tabId = active.tabId;
      }
    }

    const navigatedPage = page;
    await runAndSettle(
      navigatedPage,
      async () => {
        try {
          await navigatedPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        } catch (err) {
          if (!navigatedPage.url() || navigatedPage.url() === "about:blank") {
            throw err;
          }
        }
      },
      NAVIGATION_SETTLE
    );
    await page.bringToFront().catch(() => {});

    const snapshot = await this.getAriaSnapshot(page, tabId);
    return { page, tabId, snapshot };
  }

  public async setViewportSize(width: number, height: number): Promise<void> {
    const { page } = await this.getActivePage();
    if (width < 320 || width > 3840 || height < 320 || height > 2160) {
      throw new Error(`Viewport dimensions (${width}x${height}) out of bounds (width: 320-3840, height: 320-2160).`);
    }
    await page.setViewportSize({ width, height });
  }

  /**
   * Renders the page context plus its AI-mode ARIA snapshot, whose `[ref=eN]` markers can
   * be passed back as `ref` to target elements. With `incremental`, only nodes that changed
   * since the last snapshot of this page are printed; it falls back to the full tree after
   * a URL change or when the diff wouldn't be meaningfully smaller.
   */
  public async getAriaSnapshot(page?: Page, tabId?: string, incremental = false): Promise<string> {
    const targetPage = page ?? (await this.getActivePage()).page;
    const targetId = tabId ?? this.pageToId.get(targetPage) ?? this.activeTabId ?? "tab-1";

    const title = await targetPage.title();
    const url = targetPage.url();

    let rawAria = "";
    let snapshotHeading = "=== ARIA SNAPSHOT (use [ref=...] values as `ref` to target elements) ===";
    try {
      const yaml = (await targetPage.ariaSnapshot({ mode: "ai", timeout: 5000 })).trim();
      rawAria = yaml;

      const baseline = this.snapshotBaselines.get(targetPage);
      if (incremental && baseline && stripHash(baseline.url) === stripHash(url)) {
        const diff = diffSnapshots(baseline.yaml, yaml);
        if (!diff) {
          rawAria = "(no changes since the previous snapshot)";
          snapshotHeading = "=== ARIA SNAPSHOT (incremental) ===";
        } else if (diff.length < yaml.length * 0.6) {
          rawAria = diff;
          snapshotHeading =
            "=== ARIA SNAPSHOT (incremental: only changed/new nodes and their ancestors; omitted nodes are unchanged and their refs stay valid) ===";
        }
      }
      this.snapshotBaselines.set(targetPage, { yaml, url });
    } catch (err) {
      rawAria = `[Failed to compute ARIA snapshot: ${err instanceof Error ? err.message : String(err)}]`;
    }

    const tabsSummary = Array.from(this.tabs.entries())
      .map(([id, p]) => `${id}: ${id === targetId ? "(Active) " : ""}${p.url()}`)
      .join("\n");

    const dialogNote =
      this.lastDialog && Date.now() - this.lastDialog.timestamp < 15000
        ? `Recent Dialog (${this.lastDialog.type}): "${this.lastDialog.message}" (Auto-handled)\n`
        : "";

    return [
      `=== PAGE CONTEXT ===`,
      `Active Tab: ${targetId}`,
      `Title: ${title}`,
      `URL: ${url}`,
      dialogNote ? dialogNote.trim() : "",
      `Open Tabs:\n${tabsSummary}`,
      ``,
      snapshotHeading,
      rawAria,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Builds a locator from the most specific option given: ref > selector > testId >
   * role+name/text > label > placeholder > text > role. `defaultRole` is used only when no
   * other option is provided, so it never shadows an explicit label or placeholder.
   */
  public resolveLocator(page: Page, options: LocateOptions, defaultRole?: string): Locator {
    const { ref, selector, role, name, text, label, placeholder, testId } = options;
    const exact = options.exact ?? false;

    if (ref) {
      return page.getByRef(ref);
    }
    if (selector) {
      return page.locator(selector);
    }
    if (testId) {
      return page.getByTestId(testId);
    }
    if (role && name) {
      return page.getByRole(role as any, { name, exact });
    }
    if (role && text) {
      return page.getByRole(role as any).filter({ hasText: text });
    }
    if (label) {
      return page.getByLabel(label, { exact });
    }
    if (placeholder) {
      return page.getByPlaceholder(placeholder, { exact });
    }
    if (text) {
      return page.getByText(text, { exact });
    }
    if (role ?? defaultRole) {
      return page.getByRole((role ?? defaultRole) as any, name ? { name, exact } : undefined);
    }

    throw new Error(
      "No locator options provided. Specify `ref` from the snapshot, or one of: { role, name }, { selector }, { text }, { label }, { placeholder }, { testId }."
    );
  }

  /**
   * Resolves `options` to a single element. Throws when nothing matches; when several
   * match, uses the first and returns a note telling the model so.
   */
  public async locateOne(
    page: Page,
    options: LocateOptions,
    defaultRole?: string
  ): Promise<{ target: Locator; note: string }> {
    const locator = this.resolveLocator(page, options, defaultRole);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(
        options.ref
          ? `Ref '${options.ref}' no longer exists on the page (the element was removed or re-rendered). Use a ref from the latest snapshot.`
          : `No element found matching ${JSON.stringify(options)}. Call browser_snapshot and target the element by ref.`
      );
    }
    if (count > 1) {
      return { target: locator.first(), note: ` (${count} elements matched; used the first — pass \`ref\` to target a specific one)` };
    }
    return { target: locator, note: "" };
  }

  /**
   * Runs `action` on the active page, waits for the page to settle, then returns `message`
   * followed by an incremental snapshot. If the action opened a new tab, that tab is now
   * active and gets a full snapshot instead.
   */
  public async performAction(action: (page: Page) => Promise<string>): Promise<string> {
    const { page, tabId } = await this.getActivePage();
    const message = await runAndSettle(page, () => action(page), ACTION_SETTLE);

    const { page: activePage, tabId: activeTabId } = await this.getActivePage();
    if (activeTabId !== tabId) {
      await activePage.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_SETTLE.maxMs }).catch(() => {});
      const tabChange = page.isClosed()
        ? `Tab ${tabId} was closed; ${activeTabId} is now active.`
        : `New tab ${activeTabId} opened and is now active.`;
      const snapshot = await this.getAriaSnapshot(activePage, activeTabId);
      return `${message}\n${tabChange}\n\n${snapshot}`;
    }
    return `${message}\n\n${await this.getAriaSnapshot(page, tabId, true)}`;
  }

  /**
   * Full snapshot of the active tab to attach to an error, so the model can recover without
   * spending a turn on browser_snapshot. Full rather than incremental: an error means the
   * model's picture of the page is wrong, and it may never have seen the diff baseline.
   * Returns "" when no browser is running; never throws.
   */
  public async snapshotForError(): Promise<string> {
    const tabId = this.activeTabId;
    const page = tabId ? this.tabs.get(tabId) : undefined;
    if (!this.browser || !tabId || !page) return "";
    return this.getAriaSnapshot(page, tabId).catch(() => "");
  }

  public async drag(startX: number, startY: number, endX: number, endY: number, steps = 10): Promise<void> {
    const { page } = await this.getActivePage();
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps });
    await page.mouse.up();
  }

  public async listTabs(): Promise<TabInfo[]> {
    const results: TabInfo[] = [];
    for (const [id, page] of this.tabs.entries()) {
      results.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => "Untitled"),
        active: id === this.activeTabId,
      });
    }
    return results;
  }

  public async switchTab(tabId: string): Promise<string> {
    if (!this.tabs.has(tabId)) {
      throw new Error(`Tab '${tabId}' not found. Available tabs: ${Array.from(this.tabs.keys()).join(", ")}`);
    }
    this.activeTabId = tabId;
    const page = this.tabs.get(tabId)!;
    await page.bringToFront().catch(() => {});
    return this.getAriaSnapshot(page, tabId);
  }

  public async closeTab(tabId?: string): Promise<string> {
    const targetId = tabId ?? this.activeTabId;
    if (!targetId || !this.tabs.has(targetId)) {
      return "No active tab to close.";
    }

    const page = this.tabs.get(targetId)!;
    await page.close();
    this.tabs.delete(targetId);

    const remaining = Array.from(this.tabs.keys());
    this.activeTabId = remaining.length > 0 ? remaining[0] : null;

    if (this.activeTabId) {
      return `Closed ${targetId}. Switched to active tab ${this.activeTabId}.`;
    }
    return `Closed ${targetId}. No open tabs remaining.`;
  }

  public async closeAll(): Promise<void> {
    const browser = this.browser;
    // Reset before awaiting, so a call arriving mid-close launches a new browser rather than
    // getting the closing one.
    this.resetState();
    await browser?.close().catch(() => {});
  }

  private resetState(): void {
    this.browser = null;
    this.context = null;
    this.tabs.clear();
    this.pageToId.clear();
    this.activeTabId = null;
  }
}

function stripHash(url: string): string {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}
