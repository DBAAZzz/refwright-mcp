import type { Page, Request } from "playwright-core";

export interface SettleOptions {
  /** Hard cap on time spent waiting after the action returns. */
  maxMs: number;
  /** How long the DOM must stay free of mutations to count as settled. */
  quietMs: number;
}

const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const ACTION_SETTLE: SettleOptions = {
  maxMs: envInt("ARIA_SETTLE_MAX_MS", 1500),
  quietMs: envInt("ARIA_SETTLE_QUIET_MS", 100),
};

export const NAVIGATION_SETTLE: SettleOptions = {
  maxMs: envInt("ARIA_NAV_SETTLE_MAX_MS", 3000),
  quietMs: ACTION_SETTLE.quietMs,
};

// Requests the page is likely waiting on to render its next state. Long-lived channels
// (websocket, eventsource) and fire-and-forget beacons (ping) would never "finish".
const TRACKED_RESOURCE_TYPES = new Set(["document", "fetch", "xhr"]);

/**
 * Resolves `true` once the DOM has had no structural mutations for `quietMs`, or `false`
 * when `maxMs` elapses first. Text-only changes and inline `style` changes are ignored:
 * clocks, tickers and JS animations rewrite them continuously and would otherwise keep the
 * page "busy" until the cap. Text that arrives from the network is still waited for,
 * because the request itself is tracked by `runAndSettle`.
 */
function waitForDomQuiet(page: Page, quietMs: number, maxMs: number): Promise<boolean> {
  return page.evaluate(
    ([quiet, max]) =>
      new Promise<boolean>((resolve) => {
        let quietTimer: ReturnType<typeof setTimeout>;
        const finish = (settled: boolean) => {
          observer.disconnect();
          clearTimeout(quietTimer);
          clearTimeout(capTimer);
          resolve(settled);
        };
        const restartQuietTimer = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(true), quiet);
        };
        const isTextNode = (node: Node) => node.nodeType === Node.TEXT_NODE;
        const isStructural = (r: MutationRecord) => {
          if (r.type === "characterData") return false;
          if (r.type === "attributes") return r.attributeName !== "style";
          return !(Array.from(r.addedNodes).every(isTextNode) && Array.from(r.removedNodes).every(isTextNode));
        };
        const observer = new MutationObserver((records) => {
          if (records.some(isStructural)) restartQuietTimer();
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const capTimer = setTimeout(() => finish(false), max);
        restartQuietTimer();
      }),
    [quietMs, maxMs] as const
  );
}

/**
 * Runs `action`, then waits until the page has settled: any navigation it triggered has
 * reached DOMContentLoaded, the fetch/XHR requests it started have finished, and the DOM
 * has stopped mutating. Never waits longer than `options.maxMs` after the action returns,
 * so a page with long-polling or constant updates costs at most that cap.
 */
export async function runAndSettle<T>(page: Page, action: () => Promise<T>, options: SettleOptions): Promise<T> {
  const inflight = new Set<Request>();
  let navigated = false;
  let onIdle: (() => void) | null = null;

  const onRequest = (request: Request) => {
    if (TRACKED_RESOURCE_TYPES.has(request.resourceType())) inflight.add(request);
  };
  const onRequestDone = (request: Request) => {
    inflight.delete(request);
    if (inflight.size === 0) onIdle?.();
  };
  const onFrameNavigated = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame()) navigated = true;
  };

  page.on("request", onRequest);
  page.on("requestfinished", onRequestDone);
  page.on("requestfailed", onRequestDone);
  page.on("framenavigated", onFrameNavigated);

  try {
    const result = await action();
    const deadline = Date.now() + options.maxMs;
    const remaining = () => deadline - Date.now();

    while (remaining() > 0 && !page.isClosed()) {
      if (navigated) {
        navigated = false;
        await page.waitForLoadState("domcontentloaded", { timeout: remaining() }).catch(() => {});
        continue;
      }
      if (inflight.size > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining());
          onIdle = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        onIdle = null;
        continue;
      }
      let quiet: boolean;
      try {
        quiet = await waitForDomQuiet(page, options.quietMs, Math.max(remaining(), 0));
      } catch {
        // A navigation destroyed the execution context mid-wait. Back off briefly so the
        // navigation event can land, then re-check.
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      // Requests are reported asynchronously, so one may have started during the quiet window.
      if (quiet && inflight.size === 0 && !navigated) break;
    }

    return result;
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestDone);
    page.off("requestfailed", onRequestDone);
    page.off("framenavigated", onFrameNavigated);
  }
}
