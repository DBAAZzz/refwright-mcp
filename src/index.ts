#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserManager } from "./browser.js";
import { ToolDispatcher, toolSchemas } from "./tools.js";

// Sent to the client at initialization so every agent learns the fast path, not just the tool list.
const USAGE_INSTRUCTIONS = `Browser automation driven by ARIA snapshots. To work fast and accurately:
- Target elements by \`ref\` (the [ref=eN] markers in snapshots). Refs are exact; role/name matching may hit several elements and then uses the first.
- Action tools (click, fill, select, check, upload, press, hover, scroll, drag) already wait for the page to settle and return an incremental snapshot of what changed. Don't call browser_snapshot after every action; call it only when you need the whole page again.
- Omitted nodes in an incremental snapshot are unchanged and their refs stay valid. If a ref no longer exists, use one from the latest snapshot.
- Errors include the current page state. Read it to recover instead of spending a call on probing.
- The browser persists between tasks (until it has been idle for a while) and may still be on an earlier page. Don't assume where you are; start from browser_open or the latest snapshot.
- Use browser_run_script only for steps whose targets you have already seen in a snapshot. On an unfamiliar page, use the single action tools: each one shows you the resulting page. Inside scripts, wait for a specific element (locator.waitFor()) rather than waitForURL or waitForLoadState('load'), which hang on pages that keep loading.
- Upload files with browser_upload; don't click upload buttons, which open the OS file picker.
- Snapshot text is the source of truth. Use screenshots and x/y coordinates only for visual content (canvas, games, images, layout).
- Pass skip_snapshot: true for intermediate steps whose result you don't need to see.`;

const SHUTDOWN_TIMEOUT_MS = 5000;
// The server lives as long as the client session, so an idle session would otherwise keep
// its Chrome open indefinitely. The next call after closing launches a fresh browser.
// 0 disables; capped at setTimeout's maximum, beyond which it would fire immediately.
const IDLE_TIMEOUT_MS = Math.min(Number(process.env.BROWSER_IDLE_TIMEOUT_MINUTES ?? 30) * 60_000, 2 ** 31 - 1);

async function main() {
  const browserManager = new BrowserManager();
  const dispatcher = new ToolDispatcher(browserManager);

  let activeCalls = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const trackCall = async <T>(call: () => Promise<T>): Promise<T> => {
    activeCalls++;
    clearTimeout(idleTimer);
    try {
      return await call();
    } finally {
      if (--activeCalls === 0 && IDLE_TIMEOUT_MS > 0) {
        idleTimer = setTimeout(() => browserManager.closeAll(), IDLE_TIMEOUT_MS).unref();
      }
    }
  };

  const server = new McpServer(
    {
      name: "refwright",
      version: "1.0.0",
    },
    { instructions: USAGE_INSTRUCTIONS }
  );

  // Register each tool
  for (const [name, definition] of Object.entries(toolSchemas)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: (definition.parameters as any).shape,
      },
      (args: any) =>
        trackCall(async () => {
          try {
            const result = await dispatcher.handleTool(name, args);
            return result;
          } catch (error: any) {
            // Playwright colors its call logs with ANSI codes, which are noise to a model.
            const reason = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, "");
            const message = `Error executing ${name}: ${reason}`;
            const pageState = await browserManager.snapshotForError();
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: pageState ? `${message}\n\nCurrent page state:\n${pageState}` : message,
                },
              ],
            };
          }
        })
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // If Chrome hangs while closing, exit anyway; the watchdog then kills it.
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    await browserManager.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  // MCP clients usually disconnect by closing our stdin rather than sending a signal, and
  // the stdio transport doesn't react to that, so the server and its Chrome would linger.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting refwright-mcp:", error);
  process.exit(1);
});
