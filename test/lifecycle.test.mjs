// Process lifecycle: the server must never leave its Chrome running after it goes away.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const posixOnly = { skip: process.platform === "win32" && "relies on pgrep" };

const chromeProcessesOf = (serverPid) =>
  execSync(`pgrep -f -- "--refwright-owner=${serverPid}( |$)" || true`).toString().trim().split("\n").filter(Boolean);
const browserProcessesOf = (serverPid) =>
  chromeProcessesOf(serverPid).filter((pid) => !execSync(`ps -o command= -p ${pid} || true`).toString().includes("--type="));
const profileDirOf = (serverPid) =>
  execSync("ps -A -ww -o args=", { maxBuffer: 64 << 20 })
    .toString()
    .split("\n")
    .filter((line) => new RegExp(`--refwright-owner=${serverPid}( |$)`).test(line))
    .map((line) => /--user-data-dir=(\S+)/.exec(line)?.[1])
    .find(Boolean);
const spawned = [];
// A failing test must not leave servers behind: they would keep the test runner alive.
after(() => {
  for (const child of spawned) {
    child.kill("SIGKILL");
    execSync(`pkill -KILL -f -- "--refwright-owner=${child.pid}( |$)" || true`);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(200);
  }
  return condition();
}

/** Starts the server over stdio and returns a minimal JSON-RPC client for it. */
async function startServer(env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, BROWSER_HEADLESS: "true", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  spawned.push(child);
  const pending = new Map();
  let buffer = "";
  let nextId = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  const callTool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  return { child, callTool };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("closing the client connection shuts down the server and its Chrome", posixOnly, async () => {
  const { child, callTool } = await startServer();
  await callTool("browser_snapshot");
  assert.ok(chromeProcessesOf(child.pid).length > 0);

  child.stdin.end();

  assert.ok(await waitUntil(() => !isAlive(child.pid) && chromeProcessesOf(child.pid).length === 0, 8000));
});

test("Chrome and its temp profile are removed after the server is killed with SIGKILL", posixOnly, async () => {
  const { child, callTool } = await startServer();
  await callTool("browser_snapshot");
  const profileDir = profileDirOf(child.pid);
  assert.ok(profileDir && existsSync(profileDir));

  child.kill("SIGKILL");

  assert.ok(await waitUntil(() => chromeProcessesOf(child.pid).length === 0, 8000));
  assert.ok(await waitUntil(() => !existsSync(profileDir), 4000), `${profileDir} was left behind`);
});

test("a server whose Chrome was killed from outside relaunches it on the next call", posixOnly, async () => {
  const { child, callTool } = await startServer();
  await callTool("browser_snapshot");
  execSync(`pkill -KILL -f -- "--refwright-owner=${child.pid}( |$)"`);
  await waitUntil(() => browserProcessesOf(child.pid).length === 0, 4000);

  const response = await callTool("browser_snapshot");

  assert.ok(!response.result.isError, response.result.content[0].text);
  assert.equal(browserProcessesOf(child.pid).length, 1);
  child.kill("SIGTERM");
  await waitUntil(() => chromeProcessesOf(child.pid).length === 0, 8000);
});

test("an idle browser is closed, and the next call launches a new one", posixOnly, async () => {
  const { child, callTool } = await startServer({ BROWSER_IDLE_TIMEOUT_MINUTES: "0.02" });
  await callTool("browser_snapshot");

  assert.ok(await waitUntil(() => chromeProcessesOf(child.pid).length === 0, 8000));
  assert.ok(isAlive(child.pid));

  const response = await callTool("browser_snapshot");
  assert.ok(!response.result.isError, response.result.content[0].text);
  child.kill("SIGTERM");
  await waitUntil(() => chromeProcessesOf(child.pid).length === 0, 8000);
});

test("killing one server leaves another server's Chrome running", posixOnly, async () => {
  const victim = await startServer();
  const survivor = await startServer();
  await victim.callTool("browser_snapshot");
  await survivor.callTool("browser_snapshot");
  assert.ok(chromeProcessesOf(victim.child.pid).length > 0);

  victim.child.kill("SIGKILL");
  assert.ok(await waitUntil(() => chromeProcessesOf(victim.child.pid).length === 0, 8000));

  assert.ok(chromeProcessesOf(survivor.child.pid).length > 0);
  survivor.child.kill("SIGTERM");
  await waitUntil(() => chromeProcessesOf(survivor.child.pid).length === 0, 8000);
});

test("concurrent first calls share a single browser", posixOnly, async () => {
  const { child, callTool } = await startServer();
  await Promise.all([callTool("browser_snapshot"), callTool("browser_snapshot"), callTool("browser_snapshot")]);

  assert.equal(browserProcessesOf(child.pid).length, 1);
  child.kill("SIGTERM");
  await waitUntil(() => chromeProcessesOf(child.pid).length === 0, 8000);
});
