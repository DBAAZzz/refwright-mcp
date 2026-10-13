// End-to-end tests against a real Chrome (set CHROME_PATH if it isn't in a standard location).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

process.env.BROWSER_HEADLESS = "true";
const { BrowserManager } = await import("../dist/browser.js");
const { ToolDispatcher } = await import("../dist/tools.js");

const pages = {
  "/": `<title>Home</title><h1>Users</h1>
<ul><li>Alice <button onclick="this.parentNode.remove()">删除</button></li><li>Bob <button onclick="this.parentNode.remove()">删除</button></li></ul>
<button onclick="fetch('/api/slow').then(r=>r.text()).then(t=>{const p=document.createElement('p');p.textContent='Result: '+t;document.body.appendChild(p)})">Load data</button>
<p id=loadstate>idle</p><button onclick="loadstate.textContent='Loading…';fetch('/api/slow').then(r=>r.text()).then(t=>loadstate.textContent='Loaded '+t)">Refresh</button>
<button>Noop</button>
<label><input type=checkbox> Newsletter</label><label><input type=checkbox> Agree terms</label>
<a href="/second" target="_blank">Open in new tab</a>`,
  "/second": `<title>Second</title><h1>Second page</h1>`,
  "/upload": `<title>Upload</title><input type=file style="display:none" onchange="out.textContent='Selected: '+this.files[0].name"><p id=out>none</p>`,
  "/upload2": `<title>Upload2</title><input type=file id=a><input type=file id=b onchange="out.textContent='B got: '+this.files[0].name"><p id=out>none</p>`,
  "/ticker": `<title>Ticker</title><p id=t>0</p><button>Go</button><script>setInterval(()=>{t.textContent=Date.now()},50)</script>`,
};

let server, base, browser, tools;

before(async () => {
  server = http
    .createServer((req, res) => {
      if (req.url === "/api/slow") return setTimeout(() => res.end("42 rows"), 400);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(pages[req.url] ?? "404");
    })
    .listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = new BrowserManager();
  tools = new ToolDispatcher(browser);
});

after(async () => {
  await browser.closeAll();
  server.close();
});

const call = async (name, args = {}) => (await tools.handleTool(name, args)).content[0].text;
const refOf = (snapshot, line) => new RegExp(`${line} \\[ref=([^\\]]+)\\]`).exec(snapshot)?.[1];

test("an action waits for data it requested and returns only what changed", async () => {
  await call("browser_open", { url: base + "/" });
  const text = await call("browser_click", { role: "button", name: "Load data" });
  assert.match(text, /Result: 42 rows/);
  assert.match(text, /incremental/);
  assert.doesNotMatch(text, /Alice/, "unchanged nodes are omitted");
});

test("text replaced after a request completes is captured", async () => {
  await call("browser_open", { url: base + "/" });
  assert.match(await call("browser_click", { role: "button", name: "Refresh" }), /Loaded 42 rows/);
});

test("clicking by ref hits that exact element among same-named ones", async () => {
  const snapshot = await call("browser_open", { url: base + "/", new_tab: true });
  const bobDelete = /Bob\n\s+- button "删除" \[ref=([^\]]+)\]/.exec(snapshot)[1];
  const text = await call("browser_click", { ref: bobDelete });
  assert.match(text, /Removed:\n- listitem .*Bob/);
  await assert.rejects(call("browser_click", { ref: bobDelete }), /no longer exists/);
  await call("browser_tabs", { action: "close" });
});

test("label locates the labelled checkbox instead of the first one", async () => {
  await call("browser_open", { url: base + "/", new_tab: true });
  const text = await call("browser_check", { label: "Agree terms", checked: true });
  assert.match(text, /checkbox "Agree terms" \[checked\]/);
  assert.doesNotMatch(text, /checkbox "Newsletter" \[checked\]/);
  await call("browser_tabs", { action: "close" });
});

test("a click with no effect reports no changes without waiting for the cap", async () => {
  await call("browser_open", { url: base + "/" });
  await call("browser_click", { role: "button", name: "Noop" });
  const started = Date.now();
  assert.match(await call("browser_click", { role: "button", name: "Noop" }), /no changes since the previous snapshot/);
  assert.ok(Date.now() - started < 1000);
});

test("a constantly ticking page does not stall actions", async () => {
  await call("browser_open", { url: base + "/ticker" });
  const started = Date.now();
  await call("browser_click", { role: "button", name: "Go" });
  assert.ok(Date.now() - started < 1000);
});

test("a link opening a new tab switches to it with a full snapshot", async () => {
  const snapshot = await call("browser_open", { url: base + "/" });
  const text = await call("browser_click", { ref: refOf(snapshot, 'link "Open in new tab"') });
  assert.match(text, /New tab tab-\d+ opened and is now active/);
  assert.match(text, /heading "Second page"/);
  await call("browser_tabs", { action: "close" });
});

test("upload uses the page's only file input even when it is hidden", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "refwright-")), "cat.png");
  writeFileSync(file, "fake image");
  await call("browser_open", { url: base + "/upload" });
  assert.match(await call("browser_upload", { paths: [file] }), /Selected: cat\.png/);
});

test("upload asks for a selector when the page has several file inputs", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "refwright-")), "cat.png");
  writeFileSync(file, "fake image");
  await call("browser_open", { url: base + "/upload2" });
  await assert.rejects(call("browser_upload", { paths: [file] }), /2 file inputs/);
  assert.match(await call("browser_upload", { paths: [file], selector: "#b" }), /B got: cat\.png/);
});

test("the MCP server advertises ref targeting and usage instructions", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { ...process.env },
    })
  );
  try {
    const { tools: list } = await client.listTools();
    const withRef = list.filter((t) => t.inputSchema.properties?.ref).map((t) => t.name);
    assert.deepEqual(withRef.sort(), ["browser_check", "browser_click", "browser_fill", "browser_hover", "browser_select", "browser_upload"]);
    assert.match(client.getInstructions() ?? "", /ref/);

    const text = (result) => result.content.map((c) => c.text ?? "").join("");
    await client.callTool({ name: "browser_open", arguments: { url: base + "/" } });

    const failedClick = await client.callTool({ name: "browser_click", arguments: { ref: "e999" } });
    assert.equal(failedClick.isError, true);
    assert.match(text(failedClick), /no longer exists[\s\S]*Current page state:[\s\S]*URL: http/);

    const failedScript = await client.callTool({
      name: "browser_run_script",
      arguments: { script: "await page.getByRole('button', { name: 'Missing' }).click({ timeout: 300 });" },
    });
    assert.equal(failedScript.isError, true);
    assert.match(text(failedScript), /Timeout 300ms[\s\S]*Current page state:[\s\S]*button "Load data"/);
    assert.doesNotMatch(text(failedScript), /\x1b\[/);

    const shot = await client.callTool({ name: "browser_run_script", arguments: { script: "return await screenshot();" } });
    assert.equal(shot.content[0].type, "image");

    const mixed = await client.callTool({
      name: "browser_run_script",
      arguments: { script: "return { title: await page.title(), shot: await screenshot() };" },
    });
    assert.match(text(mixed), /"title": "Home"[\s\S]*binary data omitted/);
  } finally {
    await client.close();
  }
});
