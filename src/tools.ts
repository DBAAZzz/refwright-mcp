import { z } from "zod";
import type { Locator, Page } from "playwright-core";
import type { BrowserManager } from "./browser.js";

const refParam = z
  .string()
  .optional()
  .describe("Element ref from the latest snapshot (e.g. 'e12'). Preferred: targets exactly that element. Other locator options are ignored when set.");

export const toolSchemas = {
  browser_open: {
    description:
      "Open or navigate to a URL. Returns the compact ARIA accessibility tree snapshot of the page immediately, showing interactive elements (buttons, links, inputs, headings) without raw HTML clutter.",
    parameters: z.object({
      url: z.string().describe("The URL to open or navigate to (e.g. 'https://github.com' or 'http://localhost:3000')."),
      new_tab: z.boolean().optional().describe("Whether to open in a new tab instead of reusing the current active tab (defaults to false)."),
    }),
  },

  browser_snapshot: {
    description:
      "Get the full ARIA accessibility snapshot of the current active page. Each element carries a [ref=...] you can pass as `ref` to other tools. Action tools already return an incremental snapshot, so call this only when you need the whole page again.",
    parameters: z.object({}),
  },

  browser_click: {
    description:
      "Click an element, preferably by `ref` from the snapshot (or role + name / text / label / CSS selector / coordinates). Waits for the page to settle (navigation, fetch/XHR, DOM mutations) and returns an incremental snapshot of what changed.",
    parameters: z.object({
      ref: refParam,
      role: z
        .string()
        .optional()
        .describe("The ARIA role of the element from the snapshot (e.g. 'button', 'link', 'heading', 'tab', 'menuitem', 'checkbox')."),
      name: z
        .string()
        .optional()
        .describe("The accessible name or title of the element from the snapshot (e.g. '登录', 'Submit', 'Search')."),
      text: z
        .string()
        .optional()
        .describe("Visible text inside or near the target element."),
      label: z
        .string()
        .optional()
        .describe("Associated label text of the form control."),
      selector: z
        .string()
        .optional()
        .describe("Optional CSS selector or XPath if semantic matching is not applicable."),
      testId: z
        .string()
        .optional()
        .describe("Optional test ID attribute (data-testid)."),
      exact: z
        .boolean()
        .optional()
        .describe("Whether accessible name matching must be exact (default false)."),
      x: z
        .number()
        .optional()
        .describe("Direct coordinate X to click (for Canvas, web games, or custom drawn UI)."),
      y: z
        .number()
        .optional()
        .describe("Direct coordinate Y to click (for Canvas, web games, or custom drawn UI)."),
      double_click: z
        .boolean()
        .optional()
        .describe("Perform double click instead of single click (defaults to false)."),
      skip_snapshot: z
        .boolean()
        .optional()
        .describe("Fast mode: return immediately after clicking, without waiting for the page to settle or taking a snapshot (default false)."),
    }),
  },

  browser_fill: {
    description:
      "Fill or type text into a form input or textarea, preferably by `ref` (or role / name / label / placeholder / selector). Returns an incremental snapshot of what changed.",
    parameters: z.object({
      value: z.string().describe("The text value to enter."),
      ref: refParam,
      role: z.string().optional().describe("ARIA role of the input (default 'textbox')."),
      name: z.string().optional().describe("Accessible name of the input from the snapshot."),
      label: z.string().optional().describe("Associated form label text."),
      placeholder: z.string().optional().describe("Placeholder text of the input field."),
      selector: z.string().optional().describe("Optional CSS selector for the input element."),
      press_enter: z.boolean().optional().describe("Whether to press Enter immediately after filling (useful for search bars)."),
      skip_snapshot: z
        .boolean()
        .optional()
        .describe("Fast mode: return immediately after filling, without waiting or snapshot (default false)."),
    }),
  },

  browser_press: {
    description:
      "Send a keyboard key press to the active page (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Backspace').",
    parameters: z.object({
      key: z.string().describe("Key name to press (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace')."),
      skip_snapshot: z.boolean().optional().describe("Fast mode: return immediately without waiting or snapshot."),
    }),
  },

  browser_hover: {
    description:
      "Hover over an element or coordinate to trigger hover states, dropdowns, menus, or tooltips.",
    parameters: z.object({
      ref: refParam,
      role: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
      selector: z.string().optional(),
      testId: z.string().optional(),
      x: z.number().optional().describe("Direct X coordinate to hover over."),
      y: z.number().optional().describe("Direct Y coordinate to hover over."),
      skip_snapshot: z.boolean().optional().describe("Fast mode: return immediately without waiting or snapshot."),
    }),
  },

  browser_drag: {
    description:
      "Drag from starting coordinate to ending coordinate. Crucial for sliders, puzzles, Canvas/game dragging, and reordering.",
    parameters: z.object({
      start_x: z.number().describe("Starting X coordinate."),
      start_y: z.number().describe("Starting Y coordinate."),
      end_x: z.number().describe("Ending X coordinate."),
      end_y: z.number().describe("Ending Y coordinate."),
      steps: z.number().optional().describe("Interpolation steps (default 10)."),
      skip_snapshot: z.boolean().optional().describe("Fast mode: skip ARIA snapshot."),
    }),
  },

  browser_select: {
    description:
      "Select an option in a dropdown or <select> form element by value or label.",
    parameters: z.object({
      value: z.string().describe("Option value or visible text to select."),
      ref: refParam,
      role: z.string().optional().describe("Role (default 'combobox')."),
      name: z.string().optional(),
      label: z.string().optional(),
      selector: z.string().optional(),
      testId: z.string().optional(),
      skip_snapshot: z.boolean().optional(),
    }),
  },

  browser_check: {
    description:
      "Check or uncheck a checkbox or radio button.",
    parameters: z.object({
      checked: z.boolean().default(true).describe("Whether to check (true) or uncheck (false)."),
      ref: refParam,
      role: z.string().optional().describe("Role ('checkbox' or 'radio')."),
      name: z.string().optional(),
      label: z.string().optional(),
      selector: z.string().optional(),
      testId: z.string().optional(),
      skip_snapshot: z.boolean().optional(),
    }),
  },

  browser_upload: {
    description:
      "Upload local files into a file input. File inputs are usually hidden and absent from snapshots, so by default the page's only <input type=file> is used; pass `selector` (or `ref`) when there are several. Use this instead of clicking upload buttons, which would open the OS file picker. Returns an incremental snapshot of what changed.",
    parameters: z.object({
      paths: z.array(z.string()).min(1).describe("Absolute paths of the files to upload."),
      ref: refParam,
      selector: z.string().optional().describe("CSS selector of the file input, needed only when the page has several."),
      skip_snapshot: z.boolean().optional().describe("Fast mode: return immediately without waiting or snapshot."),
    }),
  },

  browser_scroll: {
    description:
      "Scroll the active page up, down, to top, or to bottom. Returns an updated ARIA snapshot of the visible content.",
    parameters: z.object({
      direction: z.enum(["up", "down", "top", "bottom"]).default("down").describe("Scroll direction (default 'down')."),
      amount: z.number().optional().describe("Pixel amount to scroll when direction is 'up' or 'down' (default 500)."),
      skip_snapshot: z.boolean().optional().describe("Fast mode: return immediately without waiting or snapshot."),
    }),
  },

  browser_set_viewport: {
    description:
      "Set browser viewport dimensions for responsive testing (width: 320-3840, height: 320-2160).",
    parameters: z.object({
      width: z.number().describe("Viewport width in CSS pixels (320 - 3840)."),
      height: z.number().describe("Viewport height in CSS pixels (320 - 2160)."),
    }),
  },

  browser_screenshot: {
    description:
      "Capture a visual screenshot of the current page. Use only when visual confirmation of layout/image/canvas is required, or when requested by the user.",
    parameters: z.object({
      full_page: z.boolean().optional().describe("Whether to capture full scrollable page (default false)."),
      save_path: z.string().optional().describe("Optional absolute file path to save the screenshot PNG on disk."),
    }),
  },

  browser_evaluate: {
    description:
      "Execute JavaScript in the page context. Use for custom DOM queries or actions that cannot be expressed with standard locators.",
    parameters: z.object({
      script: z.string().describe("JavaScript code string to evaluate in the browser page context."),
    }),
  },

  browser_run_script: {
    description:
      "Execute an async Playwright automation script in the Node host environment. Runs multi-step interactions (clicks, waits, page evaluations, loops, assertions, screenshots) in a single turn without round-trip latency. Injected scope: { page, context, browser, tabId, getSnapshot, getByRef, getByRole, getByText, getByTestId, locator, click, fill, evaluate, delay, screenshot }.",
    parameters: z.object({
      script: z
        .string()
        .describe(
          "Async JavaScript code block. E.g.: `await page.click('button'); await page.waitForTimeout(300); return await page.evaluate(() => window.engine.status);`"
        ),
    }),
  },

  browser_tabs: {
    description:
      "Manage browser tabs: list all open tabs, switch to a specific tab, or close a tab.",
    parameters: z.object({
      action: z.enum(["list", "switch", "close"]).describe("Action to perform on tabs."),
      tab_id: z.string().optional().describe("Target tab ID (e.g. 'tab-1') required for 'switch' and optional for 'close'."),
    }),
  },
};

export type ToolResponse =
  | {
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      content: Array<{ type: "image"; data: string; mimeType: string }>;
    }
  | {
      isError: boolean;
      content: Array<{ type: "text"; text: string }>;
    };

// A Buffer nested in a script result would serialize as a huge byte array and flood the
// model's context; images are only viewable when returned on their own.
const omitBinary = (_key: string, value: unknown) =>
  value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)
    ? "[binary data omitted — return a screenshot on its own to view it]"
    : value;

const textResponse = (text: string): ToolResponse => ({ content: [{ type: "text" as const, text }] });

export class ToolDispatcher {
  constructor(private browserManager: BrowserManager) {}

  /**
   * Runs an action on the active page. Normally waits for the page to settle and appends an
   * incremental snapshot; with `skipSnapshot` it returns right after the action.
   */
  private async act(skipSnapshot: boolean | undefined, action: (page: Page) => Promise<string>): Promise<ToolResponse> {
    if (skipSnapshot) {
      const { page } = await this.browserManager.getActivePage();
      return textResponse(await action(page));
    }
    return textResponse(await this.browserManager.performAction(action));
  }

  public async handleTool(name: string, args: Record<string, any>): Promise<ToolResponse> {
    switch (name) {
      case "browser_open": {
        const result = await this.browserManager.open(args.url, args.new_tab);
        return textResponse(result.snapshot);
      }

      case "browser_snapshot": {
        return textResponse(await this.browserManager.getAriaSnapshot());
      }

      case "browser_click": {
        return this.act(args.skip_snapshot, async (page) => {
          // Coordinate click (CUA mode for Canvas / web games)
          if (args.x !== undefined && args.y !== undefined) {
            if (args.double_click) {
              await page.mouse.dblclick(args.x, args.y);
            } else {
              await page.mouse.click(args.x, args.y);
            }
            return `Clicked at coordinates (${args.x}, ${args.y}).`;
          }

          const { target, note } = await this.browserManager.locateOne(page, {
            ref: args.ref,
            role: args.role,
            name: args.name,
            text: args.text,
            label: args.label,
            selector: args.selector,
            testId: args.testId,
            exact: args.exact,
          });
          if (args.double_click) {
            await target.dblclick({ timeout: 5000 });
          } else {
            await target.click({ timeout: 5000 });
          }
          return `Clicked element${note}.`;
        });
      }

      case "browser_fill": {
        return this.act(args.skip_snapshot, async (page) => {
          const { target, note } = await this.browserManager.locateOne(
            page,
            {
              ref: args.ref,
              role: args.role,
              name: args.name,
              label: args.label,
              placeholder: args.placeholder,
              selector: args.selector,
            },
            "textbox"
          );
          await target.fill(args.value, { timeout: 5000 });
          if (args.press_enter) {
            await target.press("Enter", { timeout: 3000 });
          }
          return `Filled '${args.value}' into input${note}${args.press_enter ? " and pressed Enter" : ""}.`;
        });
      }

      case "browser_press": {
        return this.act(args.skip_snapshot, async (page) => {
          await page.keyboard.press(args.key);
          return `Pressed key '${args.key}'.`;
        });
      }

      case "browser_hover": {
        return this.act(args.skip_snapshot, async (page) => {
          if (args.x !== undefined && args.y !== undefined) {
            await page.mouse.move(args.x, args.y);
            return `Hovered at coordinates (${args.x}, ${args.y}).`;
          }
          const { target, note } = await this.browserManager.locateOne(page, {
            ref: args.ref,
            role: args.role,
            name: args.name,
            text: args.text,
            selector: args.selector,
            testId: args.testId,
          });
          await target.hover({ timeout: 5000 });
          return `Hovered over element${note}.`;
        });
      }

      case "browser_drag": {
        return this.act(args.skip_snapshot, async () => {
          await this.browserManager.drag(args.start_x, args.start_y, args.end_x, args.end_y, args.steps ?? 10);
          return `Dragged from (${args.start_x}, ${args.start_y}) to (${args.end_x}, ${args.end_y}).`;
        });
      }

      case "browser_select": {
        return this.act(args.skip_snapshot, async (page) => {
          const { target, note } = await this.browserManager.locateOne(
            page,
            {
              ref: args.ref,
              role: args.role,
              name: args.name,
              label: args.label,
              selector: args.selector,
              testId: args.testId,
            },
            "combobox"
          );
          const selected = await target.selectOption(args.value, { timeout: 5000 });
          return `Selected value(s): ${JSON.stringify(selected)}${note}.`;
        });
      }

      case "browser_check": {
        return this.act(args.skip_snapshot, async (page) => {
          const { target, note } = await this.browserManager.locateOne(
            page,
            {
              ref: args.ref,
              role: args.role,
              name: args.name,
              label: args.label,
              selector: args.selector,
              testId: args.testId,
            },
            "checkbox"
          );
          if (args.checked) {
            await target.check({ timeout: 5000 });
          } else {
            await target.uncheck({ timeout: 5000 });
          }
          return `${args.checked ? "Checked" : "Unchecked"} element${note}.`;
        });
      }

      case "browser_upload": {
        return this.act(args.skip_snapshot, async (page) => {
          let target: Locator;
          let note = "";
          if (args.ref || args.selector) {
            ({ target, note } = await this.browserManager.locateOne(page, { ref: args.ref, selector: args.selector }));
          } else {
            target = page.locator('input[type="file"]');
            const count = await target.count();
            if (count === 0) {
              throw new Error("No file input on the page. Open the page's upload area first, then call browser_upload again.");
            }
            if (count > 1) {
              throw new Error(`The page has ${count} file inputs. Pass \`selector\` to choose one, e.g. 'input[type=file] >> nth=1'.`);
            }
          }
          await target.setInputFiles(args.paths, { timeout: 5000 });
          return `Uploaded ${args.paths.length} file(s)${note}.`;
        });
      }

      case "browser_scroll": {
        return this.act(args.skip_snapshot, async (page) => {
          const amount = args.amount ?? 500;
          if (args.direction === "top") {
            await page.evaluate(() => window.scrollTo(0, 0));
          } else if (args.direction === "bottom") {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          } else if (args.direction === "up") {
            await page.evaluate((y: number) => window.scrollBy(0, -y), amount);
          } else {
            await page.evaluate((y: number) => window.scrollBy(0, y), amount);
          }
          return `Scrolled ${args.direction}.`;
        });
      }

      case "browser_set_viewport": {
        await this.browserManager.setViewportSize(args.width, args.height);
        return textResponse(`Viewport successfully set to ${args.width}x${args.height}.`);
      }

      case "browser_screenshot": {
        const { page } = await this.browserManager.getActivePage();
        const buffer = await page.screenshot({ fullPage: args.full_page ?? false });
        const base64 = buffer.toString("base64");

        if (args.save_path) {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(args.save_path), { recursive: true });
          writeFileSync(args.save_path, buffer);
        }

        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
            },
          ],
        };
      }

      case "browser_evaluate": {
        const { page } = await this.browserManager.getActivePage();
        const result = await page.evaluate(args.script);
        return textResponse(`Evaluation result:\n${JSON.stringify(result, null, 2)}`);
      }

      case "browser_run_script": {
        const { page, tabId } = await this.browserManager.getActivePage();
        const { browser, context } = await this.browserManager.getBrowser();
        const getSnapshot = () => this.browserManager.getAriaSnapshot(page, tabId);

        const helpers: Record<string, any> = {
          page,
          context,
          browser,
          tabId,
          getSnapshot,
          locator: (sel: string) => page.locator(sel),
          getByRole: (role: any, opts?: any) => page.getByRole(role, opts),
          getByText: (text: string, opts?: any) => page.getByText(text, opts),
          getByTestId: (id: string) => page.getByTestId(id),
          getByRef: (ref: string) => page.getByRef(ref),
          click: async (target: any, opts?: any) => {
            if (typeof target === "string") {
              await page.locator(target).first().click(opts);
            } else if (target && typeof target.x === "number") {
              await page.mouse.click(target.x, target.y, opts);
            } else if (target && target.click) {
              await target.click(opts);
            }
          },
          fill: async (selector: string, value: string) => {
            await page.locator(selector).first().fill(value);
          },
          evaluate: (fn: any, ...evalArgs: any[]) => page.evaluate(fn, ...evalArgs),
          delay: (ms: number) => page.waitForTimeout(ms),
          // Returned alone, a Buffer becomes an image block the model can see.
          screenshot: (fullPage = false) => page.screenshot({ fullPage }),
        };

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction(...Object.keys(helpers), args.script);

        const result = await fn(...Object.values(helpers));

        if (result && typeof result === "object" && result.__image) {
          return {
            content: [
              {
                type: "image" as const,
                data: result.__image,
                mimeType: "image/png",
              },
            ],
          };
        }

        if (Buffer.isBuffer(result)) {
          return {
            content: [
              {
                type: "image" as const,
                data: result.toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        }

        return textResponse(
          typeof result === "string"
            ? result
            : result === undefined
            ? "Script executed successfully (returned undefined)."
            : JSON.stringify(result, omitBinary, 2)
        );
      }

      case "browser_tabs": {
        if (args.action === "list") {
          const tabs = await this.browserManager.listTabs();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(tabs, null, 2) }],
          };
        }
        if (args.action === "switch") {
          if (!args.tab_id) throw new Error("tab_id is required for action 'switch'");
          const snapshot = await this.browserManager.switchTab(args.tab_id);
          return {
            content: [{ type: "text" as const, text: `Switched to ${args.tab_id}.\n\n${snapshot}` }],
          };
        }
        if (args.action === "close") {
          const result = await this.browserManager.closeTab(args.tab_id);
          return {
            content: [{ type: "text" as const, text: result }],
          };
        }
        throw new Error(`Unsupported tab action: ${args.action}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
