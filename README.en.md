# refwright-mcp

[中文](./README.md) | **English**

> An MCP server that lets AI agents drive the browser **fast and accurately**: built on Playwright and ARIA accessibility snapshots, with ref-based targeting, smart settle and incremental snapshots.

---

## Why refwright-mcp

When an agent drives a browser, speed is rarely limited by the browser. It is limited by **how many round trips the agent needs and how much text it reads each time**. One model turn takes seconds; a click takes milliseconds. Common approaches fall short on both:

| Common approach | Problem | What refwright-mcp does |
|---|---|---|
| Dump the page HTML | Tens of thousands of tokens of DOM, SVG and inline CSS — costly and distracting | Emits a compact **ARIA tree**: roles, accessible names and states only |
| Screenshot + vision coordinates | Slow and expensive; small text gets missed and clicks land off-target | Semantic targeting first; coordinates only for canvas, games and the like |
| Guess elements by role + name | With ten "Delete" buttons on a page, the first one gets clicked | Every element carries a **`[ref=e12]`**; clicking by ref hits exactly that element |
| Fixed sleep after each action | Too short returns a stale page and the agent retries; too long wastes time | **Smart settle**: waits only for the navigation, requests and DOM changes the action caused, capped at 1.5 s |
| Full snapshot after every step | Large pages fill the context in a few steps and the model slows down | **Incremental snapshots**: return only what changed, plus what was removed |

In short: **fewer turns, fewer tokens, no misclicks** — the three things that decide how fast an agent actually gets through a browser task.

### Measured on local test pages

| Scenario | Time | Returned |
|---|---|---|
| Click that changes nothing | ~130 ms | `(no changes since the previous snapshot)` |
| Click whose API responds after 400 ms | ~550 ms | Snapshot already contains the response data |
| Page with a timer ticking every 50 ms | ~140 ms | Doesn't wait out the cap on constantly changing pages |
| Delete a row from a list | ~140 ms | 4-line diff naming the removed row |

### What an incremental snapshot looks like

Opening a page returns the full snapshot, every element with a ref:

```yaml
- generic [ref=e1]:
  - list [ref=e3]:
    - listitem [ref=e4]:
      - text: Alice
      - button "删除" [ref=e5]
    - listitem [ref=e6]:
      - text: Bob
      - button "删除" [ref=e7]
  - button "Load data" [ref=e8]
```

After `browser_click({ ref: "e7" })`, only the change comes back:

```yaml
- generic [ref=e1]:
  - list [ref=e3]:

Removed:
- listitem [ref=e6]: Bob | button "删除" [ref=e7]
```

Nodes missing from an incremental snapshot are unchanged, and their refs stay valid.

---

## Features

- 🔖 **Ref targeting**: pass `[ref=eN]` from the snapshot to click / fill / select / check / hover, including elements inside iframes. A stale ref fails immediately with a hint to use the latest snapshot, instead of hanging until a timeout.
- ⏱ **Smart settle**: after an action, waits until the navigation it triggered completes, the fetch/XHR requests it started finish, and the DOM has had no structural change for 100 ms. Text-only and inline-style changes (clocks, tickers, carousels) don't hold it up.
- ✂️ **Incremental snapshots**: action tools return changed nodes, their ancestors and removed nodes. Falls back to the full tree after navigation or when the diff wouldn't be meaningfully smaller.
- ⚡ **Script batching**: `browser_run_script` runs a known multi-step flow in a single call.
- 🎯 **Semantic + coordinate targeting**: semantic or ref targeting for regular pages; coordinate clicks and drags for canvas, games and slider captchas.
- 🧭 **Built-in usage guidance**: the server sends MCP `instructions` telling any connected agent how to use the tools efficiently.
- 🚀 **Uses your local Chrome**: built on `playwright-core`, auto-detects the installed Chrome — no separate browser download. Picks up the system proxy.
- 📑 **Multi-tab**: new tabs and popups are tracked and focused automatically; list, switch and close tabs.
- 🧹 **No orphaned Chrome**: the browser is closed when the client disconnects or the server is signalled; even if the server is `kill -9`ed or crashes, a detached watchdog reaps its Chrome within seconds without touching other instances.

---

## Quick start

Requires **Node.js ≥ 20** and a locally installed Google Chrome or Chromium.

```bash
git clone https://github.com/DBAAZzz/refwright-mcp.git
cd refwright-mcp
pnpm install
pnpm run build
```

The server entry is `dist/index.js`. Replace `/absolute/path/to/refwright-mcp` below with your local path.

### Claude Code

```bash
claude mcp add refwright -- node /absolute/path/to/refwright-mcp/dist/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "refwright": {
      "command": "node",
      "args": ["/absolute/path/to/refwright-mcp/dist/index.js"]
    }
  }
}
```

### Cursor / Windsurf / Antigravity and others

Add the same `command` and `args` to the client's MCP settings. For Antigravity, the file is `~/.gemini/antigravity/mcp_config.json` with the same format.

---

## Tools

| Tool | Main parameters | Description |
|---|---|---|
| `browser_open` | `url`, `new_tab` | Open a URL and return the full snapshot. Reuses an existing tab on the same origin |
| `browser_snapshot` | — | Full snapshot (with refs) of the active page plus tab info |
| `browser_click` | `ref`, `role`, `name`, `text`, `label`, `selector`, `testId`, `exact`, `x`, `y`, `double_click`, `skip_snapshot` | Click an element or coordinates |
| `browser_fill` | `value`, `ref`, `role`, `name`, `label`, `placeholder`, `selector`, `press_enter`, `skip_snapshot` | Fill an input, optionally pressing Enter |
| `browser_select` | `value`, `ref`, `name`, `label`, `selector`, `testId`, `skip_snapshot` | Choose a dropdown option |
| `browser_check` | `checked`, `ref`, `name`, `label`, `selector`, `testId`, `skip_snapshot` | Check or uncheck a checkbox / radio |
| `browser_hover` | `ref`, `role`, `name`, `text`, `selector`, `testId`, `x`, `y`, `skip_snapshot` | Hover to open menus and tooltips |
| `browser_press` | `key`, `skip_snapshot` | Press a key such as `Enter`, `Escape`, `Tab`, `ArrowDown` |
| `browser_scroll` | `direction` (`up`/`down`/`top`/`bottom`), `amount`, `skip_snapshot` | Scroll the page |
| `browser_drag` | `start_x`, `start_y`, `end_x`, `end_y`, `steps`, `skip_snapshot` | Drag between coordinates (sliders, puzzles, canvas) |
| `browser_set_viewport` | `width`, `height` | Set viewport size (320–3840 × 320–2160) |
| `browser_screenshot` | `full_page`, `save_path` | PNG screenshot, optionally saved to disk |
| `browser_evaluate` | `script` | Run JavaScript in the page context |
| `browser_run_script` | `script` | Run a Playwright script in Node to batch multiple steps. In scope: `page`, `context`, `browser`, `tabId`, `getSnapshot`, `getByRef`, `getByRole`, `getByText`, `getByTestId`, `locator`, `click`, `fill`, `evaluate`, `delay`, `screenshot` |
| `browser_tabs` | `action` (`list`/`switch`/`close`), `tab_id` | Manage tabs |

**Locator priority**: `ref` > `selector` > `testId` > `role`+`name`/`text` > `label` > `placeholder` > `text` > `role`.

**`skip_snapshot: true`** returns right after the action, skipping both the settle wait and the snapshot — useful for intermediate steps.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `false` | The browser window is shown by default so you can watch the agent; set `"true"` for headless |
| `CHROME_PATH` | auto-detected | Path to a Chrome / Chromium executable |
| `BROWSER_PROXY` | auto-detected | Proxy server; otherwise `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, then the macOS system proxy |
| `ARIA_SETTLE_MAX_MS` | `1500` | Max wait after an action |
| `ARIA_SETTLE_QUIET_MS` | `100` | How long the DOM must be free of structural changes to count as settled |
| `ARIA_NAV_SETTLE_MAX_MS` | `3000` | Max extra wait after `browser_open` reaches DOMContentLoaded |

---

## Security notes

This server is meant for **local, trusted** agents. Be aware that:

- `browser_run_script` executes arbitrary code in the **Node host process**, with the permissions of the user running the server.
- `browser_screenshot`'s `save_path` can write to any path.
- `alert` / `confirm` / `prompt` dialogs are **auto-accepted**; the dialog is reported in the next snapshot.

If the agent browses untrusted sites, page content may attempt prompt injection to steer the agent toward these capabilities.

---

## Development

```bash
pnpm run build   # compile TypeScript to dist/
pnpm test        # build and run tests (end-to-end tests need a local Chrome)
```

```
src/
├── index.ts      # MCP entry: tool registration and usage instructions
├── tools.ts      # tool schemas (zod) and dispatch
├── browser.ts    # browser/tab management, locating, snapshots
├── settle.ts     # smart settle: navigation / request / DOM stability
├── snapshot.ts   # incremental snapshot diffing
└── watchdog.ts   # watchdog that reaps Chrome after an abnormal server exit
test/
├── snapshot.test.mjs  # diff unit tests
├── e2e.test.mjs       # real-browser end-to-end tests
└── lifecycle.test.mjs # process lifecycle: disconnect, SIGKILL, multiple instances, concurrent launch
```

## License

[MIT](./LICENSE)
