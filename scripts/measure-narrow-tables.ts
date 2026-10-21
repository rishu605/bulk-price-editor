#!/usr/bin/env node
/**
 * Renders every price table #804 names at phone and narrow-window widths, in real Chrome
 * with real Polaris, and fails if any cell's content is cut off.
 *
 *   npx tsx scripts/measure-narrow-tables.ts
 *   npx tsx scripts/measure-narrow-tables.ts --widths 390,606,1024 --polaris ./polaris.js
 *   npx tsx scripts/measure-narrow-tables.ts --pages live,campaigns --screenshots /tmp
 *   npx tsx scripts/measure-narrow-tables.ts --out /tmp/narrow   # keep the harness to open
 *
 * The admin embeds the app in a cross-origin iframe that browser automation cannot reach
 * into, so this builds the same thing locally: the app's own page components, bundled with
 * their server modules stubbed, rendered in an iframe of the width under test -- an iframe
 * because Polaris reads the frame's `window.innerWidth`, and because headless Chrome will
 * not make a window narrower than 500px.
 *
 * Polaris is fetched from Shopify's CDN, the same unversioned file the admin loads, unless
 * `--polaris` names a local copy. Chrome is `--chrome <path>`, or the usual install -- a
 * flag rather than an environment variable, because this is a tool and not something the
 * deployed app reads.
 *
 * Exit 0 when nothing is clipped, 1 when something is, 2 when it could not measure.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build, type Plugin } from "esbuild";

import type { PageReport } from "./narrow-tables/measure";

const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
const PAGES = ["live", "variants", "baselines", "drift", "campaigns", "preview", "ledger", "runs"];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const widths = (arg("widths") ?? "390,606").split(",").map(Number);
const pages = arg("pages")?.split(",") ?? PAGES;

/**
 * Server modules become an object that answers every question with itself.
 *
 * A route module's top level calls `withGuard(...)` and reads `boundary.headers`; nothing
 * the page component renders ever reaches them. CommonJS, so a named import of anything
 * resolves rather than failing the bundle.
 *
 * The prototype is the part that matters. esbuild reads a named import from a CommonJS
 * module by copying the module's own properties onto a fresh object whose prototype is
 * the module's prototype -- and a proxy has no own properties to copy, so every name
 * would be `undefined`. A prototype that answers every name is what reaches them.
 */
const stubServer: Plugin = {
  name: "stub-server-modules",
  setup(bundle) {
    bundle.onResolve(
      { filter: /\.server(\.tsx?)?$|^@shopify\/shopify-app-react-router\/server$|^@prisma\/client/ },
      (args) => ({ path: args.path, namespace: "server-stub" }),
    );
    bundle.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "server-stub" }));
    bundle.onLoad({ filter: /.*/, namespace: "server-stub" }, () => ({
      contents: `
        const answer = (key) => (key === "__esModule" ? false : key === "then" ? undefined : stub);
        const names = new Proxy({}, { get: (_, key) => answer(key) });
        const stub = new Proxy(function () {}, {
          get: (_, key) => answer(key),
          getPrototypeOf: () => names,
          apply: () => stub,
          construct: () => stub,
        });
        module.exports = stub;
      `,
      loader: "js",
    }));
  },
};

function chrome(): string {
  const candidates = [
    arg("chrome"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error("No Chrome found. Pass --chrome <path>.");
    process.exit(2);
  }
  return found;
}

async function polaris(dir: string): Promise<void> {
  const local = arg("polaris");
  const source = local
    ? readFileSync(resolve(local), "utf8")
    : await fetch(POLARIS_URL).then((response) => {
        if (!response.ok) throw new Error(`${POLARIS_URL} answered ${response.status}`);
        return response.text();
      });
  writeFileSync(join(dir, "polaris.js"), source);
}

const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>harness</title>
<script src="./polaris.js"></script></head>
<body><div id="root"></div><pre id="report"></pre><script src="./harness.js"></script></body></html>`;

/** Every page side by side in frames of one width; the outer page collects their reports. */
const OUTER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>outer</title>
<style>body{margin:0}iframe{border:0;height:1400px;display:block}</style></head>
<body><pre id="report"></pre><script>
  const params = new URLSearchParams(location.search);
  const width = params.get("w");
  const names = params.get("pages").split(",");
  const frames = names.map((name) => {
    const frame = document.createElement("iframe");
    frame.style.width = width + "px";
    frame.src = "harness.html?page=" + name;
    document.body.appendChild(frame);
    return frame;
  });
  function collect() {
    const reports = frames.map((frame) => {
      const pre = frame.contentDocument && frame.contentDocument.getElementById("report");
      return pre && pre.textContent ? JSON.parse(pre.textContent) : null;
    });
    if (reports.every(Boolean)) document.getElementById("report").textContent = JSON.stringify(reports);
    else setTimeout(collect, 200);
  }
  setTimeout(collect, 500);
</script></body></html>`;

/**
 * Chrome, driven over the DevTools protocol.
 *
 * Not `--dump-dom`: that either dumps before the page has run, or, with a virtual time
 * budget, runs it with no frames at all -- `requestAnimationFrame` and `ResizeObserver`
 * never fire, which would measure a page nothing had laid out.
 */
class Browser {
  private next = 1;
  private pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }

  static async launch(path: string, profile: string): Promise<Browser> {
    const child = spawn(
      path,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        // The outer page reads the frames' reports, and file:// frames are cross-origin
        // without this.
        "--allow-file-access-from-files",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--window-size=1400,1000",
        // A CI runner's Ubuntu restricts the user namespaces Chrome's sandbox needs, and the
        // pages here are the app's own, built locally (#804). A flag the workflow passes, not
        // an environment variable: the app's runbook documents every variable it reads.
        ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const endpoint = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${seen.slice(-500)}`)), 30_000);
      child.stderr?.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", () => reject(new Error(`Chrome exited: ${seen.slice(-500)}`)));
    });

    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Browser(child, socket);
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (message) =>
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result as T),
      );
    });
  }

  /** Resolves once Chrome has exited, so its profile can be removed. */
  close(): Promise<void> {
    this.socket.close();
    if (this.child.exitCode !== null) return Promise.resolve();
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill();
    return exited;
  }
}

async function measureAt(browser: Browser, dir: string, width: number): Promise<PageReport[]> {
  const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await browser.send(
    "Page.navigate",
    { url: `file://${dir}/outer.html?w=${width}&pages=${pages.join(",")}` },
    sessionId,
  );

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { result } = await browser.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      { expression: "document.getElementById('report')?.textContent ?? ''", returnByValue: true },
      sessionId,
    );
    if (result.value) {
      const shots = arg("screenshots");
      if (shots) {
        // The frames stack down the page, one per table page, each 1400px tall.
        const { data } = await browser.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height: 1400 * pages.length, scale: 1 },
          },
          sessionId,
        );
        writeFileSync(join(resolve(shots), `narrow-tables-${width}.png`), Buffer.from(data, "base64"));
      }
      await browser.send("Target.closeTarget", { targetId });
      return JSON.parse(result.value) as PageReport[];
    }
  }
  throw new Error(`No report at ${width}px within 90 seconds.`);
}

async function main() {
  // `--out` keeps the built harness, to open in a browser and resize by hand.
  const out = arg("out");
  const dir = out ? resolve(out) : mkdtempSync(join(tmpdir(), "narrow-tables-"));
  await build({
    entryPoints: [join(import.meta.dirname, "narrow-tables", "harness.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: join(dir, "harness.js"),
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [stubServer],
    logLevel: "error",
  });
  await polaris(dir);
  writeFileSync(join(dir, "harness.html"), HARNESS_HTML);
  writeFileSync(join(dir, "outer.html"), OUTER_HTML);

  const browser = await Browser.launch(chrome(), join(dir, "profile"));
  let clipped = 0;
  let unmeasured = 0;

  try {
    for (const width of widths) {
      const reports = await measureAt(browser, dir, width);
      console.log(`\n${width}px`);
      for (const report of reports) {
        if (!report.tables || report.tables.length === 0) {
          unmeasured += 1;
          console.log(`  ${String(report.page).padEnd(10)} NO TABLE RENDERED ${JSON.stringify(report)}`);
          continue;
        }
        for (const table of report.tables) {
          const verdict = table.clipped.length === 0 ? "ok" : `${table.clipped.length} CLIPPED`;
          console.log(
            `  ${report.page.padEnd(10)} ${table.layout.padEnd(5)} ${String(table.variant ?? "").padEnd(4)} ` +
              `grid ${String(table.grid ?? "-").padStart(6)} in ${String(table.available).padStart(6)}  ` +
              `money clipped ${table.clippedMoney.length}/${table.moneyCells}  ` +
              `gutters ${report.gutters.join("/")}  ${verdict}`,
          );
          for (const cell of table.clipped) {
            console.log(`      ${cell.column} · row ${cell.row}: "${cell.text}" loses ${cell.hidden}px`);
          }
          clipped += table.clipped.length;
        }
      }
    }
  } finally {
    await browser.close();
    rmSync(join(dir, "profile"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (!out) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  if (unmeasured > 0) process.exit(2);
  process.exit(clipped > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
