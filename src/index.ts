#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserManager } from "./browser.js";
import { ToolDispatcher, toolSchemas } from "./tools.js";

// Sent to the client at initialization so every agent learns the fast path, not just the tool list.
const USAGE_INSTRUCTIONS = `Browser automation driven by ARIA snapshots. To work fast and accurately:
- Target elements by \`ref\` (the [ref=eN] markers in snapshots). Refs are exact; role/name matching may hit several elements and then uses the first.
- Action tools (click, fill, select, check, press, hover, scroll, drag) already wait for the page to settle and return an incremental snapshot of what changed. Don't call browser_snapshot after every action; call it only when you need the whole page again.
- Omitted nodes in an incremental snapshot are unchanged and their refs stay valid. If a ref no longer exists, use one from the latest snapshot.
- For a known multi-step flow, use browser_run_script to do it in one call instead of one tool call per step.
- Use x/y coordinates and browser_screenshot only for canvas, games or visual checks; prefer refs everywhere else.
- Pass skip_snapshot: true for intermediate steps whose result you don't need to see.`;

async function main() {
  const browserManager = new BrowserManager();
  const dispatcher = new ToolDispatcher(browserManager);

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
      async (args: any) => {
        try {
          const result = await dispatcher.handleTool(name, args);
          return result;
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }
    );
  }

  // Handle process shutdown
  const cleanup = async () => {
    await browserManager.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting refwright-mcp:", error);
  process.exit(1);
});
