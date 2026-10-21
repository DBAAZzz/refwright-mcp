import { execFileSync, spawn } from "node:child_process";
import type { Socket } from "node:net";

/**
 * Extra Chrome switch that tags a browser as owned by this server process. Chrome ignores
 * unknown switches, and the tag lets the watchdog find exactly this server's browser.
 */
export const CHROME_OWNER_ARG = `--refwright-owner=${process.pid}`;
// The trailing `( |$)` keeps owner 123 from matching owner 1234.
const OWNER_PATTERN = `${CHROME_OWNER_ARG}( |$)`;

// stdin is a pipe from the owner, which the kernel closes however the owner dies, so `read`
// returns exactly when the owner is gone: no polling, and PID reuse can't keep it waiting.
// Then it asks Chrome to quit, force-kills it, and removes its temp profile, which
// Playwright would have removed from the owner process.
const WATCHDOG_SCRIPT = `
read _
pkill -TERM -f -- "$OWNER_PATTERN"
sleep 2
pkill -KILL -f -- "$OWNER_PATTERN"
if [ -n "$PROFILE_DIR" ]; then sleep 1; rm -rf -- "$PROFILE_DIR"; fi
`;

/**
 * Starts a detached watchdog that kills this server's Chrome once the server process has
 * exited. In-process shutdown handlers can't run on SIGKILL or a hard crash, and Chrome
 * keeps running when Playwright's connection to it drops, so without this it would be
 * orphaned. Call it after Chrome has launched, so its profile directory can be found.
 * POSIX only; on Windows this is a no-op.
 *
 * Returns a function that stops the watchdog, for use once Chrome has exited.
 */
export function startChromeWatchdog(): () => void {
  if (process.platform === "win32") return () => {};

  try {
    const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: process.env.PATH, OWNER_PATTERN, PROFILE_DIR: findProfileDir() ?? "" },
    });
    watchdog.on("error", () => {});
    watchdog.stdin?.on("error", () => {});
    // The pipe must not keep this process alive; the watchdog only needs it to exist.
    (watchdog.stdin as Socket | null)?.unref();
    watchdog.unref();
    return () => {
      watchdog.kill();
    };
  } catch {
    return () => {};
  }
}

/** The temp profile Playwright created for this server's Chrome, read from its command line. */
function findProfileDir(): string | undefined {
  try {
    const commandLines = execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8", maxBuffer: 64 << 20 });
    const owner = new RegExp(OWNER_PATTERN);
    for (const line of commandLines.split("\n")) {
      if (!owner.test(line)) continue;
      // Matching the mkdtemp name keeps the watchdog from ever deleting anything else.
      const match = /--user-data-dir=(.*?\/playwright_chromiumdev_profile-\w+)(?: |$)/.exec(line);
      if (match) return match[1];
    }
  } catch {}
  return undefined;
}
