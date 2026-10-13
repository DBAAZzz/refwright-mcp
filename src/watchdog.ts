import { spawn } from "node:child_process";

/**
 * Extra Chrome switch that tags a browser as owned by this server process. Chrome ignores
 * unknown switches, and the tag lets the watchdog find exactly this server's browser.
 */
export const CHROME_OWNER_ARG = `--refwright-owner=${process.pid}`;

// Polls the owner once a second; when it is gone, asks Chrome to quit, then force-kills.
// The trailing `( |$)` keeps owner 123 from matching owner 1234.
const WATCHDOG_SCRIPT = `
while kill -0 "$OWNER_PID" 2>/dev/null; do sleep 1; done
pattern="$OWNER_ARG( |$)"
pkill -TERM -f -- "$pattern"
sleep 2
pkill -KILL -f -- "$pattern"
`;

/**
 * Starts a detached watchdog that kills this server's Chrome once the server process has
 * exited. In-process shutdown handlers can't run on SIGKILL or a hard crash, and Chrome
 * keeps running when Playwright's connection to it drops, so without this it would be
 * orphaned. POSIX only; on Windows this is a no-op.
 *
 * Returns a function that stops the watchdog, for use after Chrome was closed normally.
 */
export function startChromeWatchdog(): () => void {
  if (process.platform === "win32") return () => {};

  try {
    const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, OWNER_PID: String(process.pid), OWNER_ARG: CHROME_OWNER_ARG },
    });
    watchdog.on("error", () => {});
    watchdog.unref();
    return () => {
      watchdog.kill();
    };
  } catch {
    return () => {};
  }
}
