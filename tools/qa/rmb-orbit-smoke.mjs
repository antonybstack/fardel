#!/usr/bin/env node
/**
 * RmbOrbitSmoke (#366 / #389): Playwright ?ve=rmb-orbit on a *seat* Vite + seat db.
 *
 * Must RMB-drag the canvas. Injecting inertial offsets or calling the
 * QA look helper is not look — those paths can pass while live
 * right-click is dead.
 *
 * Exit 0 iff:
 *   persistMark matches /^RMB orbit OK/ with dAlpha
 *   AND |hook.camera.alpha after drag - before| > 0.04
 *   AND persistMark was not OK before the drag
 *
 * Never :3000 / :5173 / db fardel / play.sparkify.dev.
 *
 *   FARDEL_VITE_PORT FARDEL_DB FARDEL_SPACETIME_URI node tools/qa/rmb-orbit-smoke.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PROD_STDB_PORT = "3000";
const PROD_VITE_PORT = "5173";
const PROD_DB = "fardel";
const TIMEOUT_MS = Number(process.env.RMB_ORBIT_SMOKE_TIMEOUT_MS || "45000");
const MIN_DALPHA = 0.15;

function die(msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  process.exit(code);
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function parseArgs(argv) {
  const out = { out: process.env.RMB_ORBIT_SMOKE_OUT || "/tmp/fardel-rmb-orbit-smoke.png", headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i] ?? out.out;
    else if (a === "--headed") out.headed = true;
  }
  return out;
}

function assertSeatEnv(vitePort, db, uri) {
  if (!vitePort || !db || !uri) {
    die(
      "RmbOrbitSmoke needs FARDEL_VITE_PORT, FARDEL_DB, FARDEL_SPACETIME_URI (source tools/scripts/wt-env.sh <slug>; never lead/:3000)",
      2,
    );
  }
  if (vitePort === PROD_VITE_PORT || db === PROD_DB) {
    die(`refusing prod/lead surface vite=${vitePort} db=${db}`, 2);
  }
  if (uri.includes(`:${PROD_STDB_PORT}`) || uri.includes("dev-db.sparkify.dev")) {
    die(`refusing prod URI ${uri}`, 2);
  }
}

function assertNotProdUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    die(`invalid client URL ${url}`, 2);
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const dbParam = parsed.searchParams.get("db") || parsed.searchParams.get("database") || "";
  const moduleParam = parsed.searchParams.get("module") || parsed.searchParams.get("name") || "";
  const ve = parsed.searchParams.get("ve") || "";
  if (
    parsed.hostname === "play.sparkify.dev" ||
    parsed.hostname === "dev-db.sparkify.dev" ||
    port === PROD_STDB_PORT ||
    port === PROD_VITE_PORT
  ) {
    die(`refusing prod/lead URL ${url}`, 2);
  }
  if (!dbParam || dbParam.includes(`:${PROD_STDB_PORT}`) || dbParam.includes("dev-db.sparkify.dev")) {
    die(`refusing URL missing/prod ?db= ${url}`, 2);
  }
  if (!moduleParam || moduleParam === PROD_DB) {
    die(`refusing URL missing/prod ?module= ${url}`, 2);
  }
  if (ve !== "rmb-orbit") {
    die(`RmbOrbitSmoke must open ?ve=rmb-orbit, got ve=${ve}`, 2);
  }
}

function isTerminalMark(mark) {
  const t = String(mark || "").trim();
  if (!t) return false;
  if (/^VE rmb-orbit:/i.test(t)) return false;
  return /RMB orbit (OK|FAIL)/i.test(t);
}

function isWaitingForDrag(mark) {
  return /waiting for RMB drag/i.test(String(mark || ""));
}

function judgeMark(mark) {
  const t = String(mark || "").trim();
  if (!t) return { ok: false, reason: "persistMark never appeared / empty" };
  if (/RMB orbit FAIL/i.test(t)) return { ok: false, reason: t };
  if (!/^RMB orbit OK/.test(t)) return { ok: false, reason: `persistMark does not match /^RMB orbit OK/: ${t}` };
  if (!/dAlpha/i.test(t)) return { ok: false, reason: `persistMark missing dAlpha: ${t}` };
  return { ok: true, reason: t };
}

function selfCheckJudge() {
  const cases = [
    ["", false],
    ["VE rmb-orbit: waiting for RMB drag", false],
    ["VE rmb-orbit: connected…", false],
    ["RMB orbit FAIL · dAlpha 0.000", false],
    ["RMB orbit OK · dAlpha 0.182", true],
    ["RMB orbit OK · dAlpha 1.740 · cursor none", true],
  ];
  for (const [mark, want] of cases) {
    const got = judgeMark(mark).ok;
    if (got !== want) {
      die(`self-check judgeMark(${JSON.stringify(mark)}) got ${got} want ${want}`);
    }
  }
}

function selfCheckSource() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  if (!/button:\s*["']right["']/.test(src)) {
    die("self-check: smoke must mouse.down({ button: 'right' })");
  }
  if (!/steps:\s*\d+/.test(src)) {
    die("self-check: smoke must mouse.move with steps (a real drag)");
  }
  if (/\.lookDelta\s*\(/.test(src)) {
    die("self-check: smoke must not call the QA look helper (that is not RMB)");
  }
  if (/inertialAlphaOffset\s*\+=/.test(src)) {
    die("self-check: smoke must not inject inertialAlphaOffset");
  }
}

async function readMark(page) {
  return page.evaluate(() => document.getElementById("persistMark")?.textContent?.trim() ?? "");
}

async function readCam(page) {
  return page.evaluate(() => {
    const qa = window.__qa;
    if (!qa || typeof qa.getState !== "function") return null;
    const cam = qa.getState().camera;
    return {
      alpha: cam.alpha,
      beta: cam.beta,
      radius: cam.radius,
      inertialAlphaOffset: cam.inertialAlphaOffset,
    };
  });
}

async function rmbDragCanvas(page) {
  const box = await page.locator("#renderCanvas").boundingBox();
  if (!box) die("no #renderCanvas bounding box");
  const x = box.x + box.width * 0.62;
  const y = box.y + box.height * 0.42;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x + 220, y, { steps: 22 });
  await page.waitForTimeout(200);
  await page.mouse.up({ button: "right" });
}

async function main() {
  selfCheckJudge();
  selfCheckSource();
  const args = parseArgs(process.argv.slice(2));
  const vitePort = env("FARDEL_VITE_PORT");
  const db = env("FARDEL_DB");
  const uri = env("FARDEL_SPACETIME_URI");
  assertSeatEnv(vitePort, db, uri);

  const url = `http://127.0.0.1:${vitePort}/?ve=rmb-orbit&db=${encodeURIComponent(uri)}&module=${encodeURIComponent(db)}`;
  assertNotProdUrl(url);
  console.log(`RmbOrbitSmoke url ${url}`);

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({
    headless: !args.headed,
    args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let mark = "";
  let dAlpha = 0;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#renderCanvas", { timeout: 20000 });

    const readyDeadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < readyDeadline) {
      mark = await readMark(page);
      if (isTerminalMark(mark) && /RMB orbit OK/i.test(mark)) {
        die(`persistMark OK before RMB drag (inject / hardcoded): ${mark}`);
      }
      const cam = await readCam(page);
      if (isWaitingForDrag(mark) && cam) break;
      await page.waitForTimeout(200);
    }
    mark = await readMark(page);
    if (isTerminalMark(mark) && /RMB orbit OK/i.test(mark)) {
      die(`persistMark OK before RMB drag (inject / hardcoded): ${mark}`);
    }
    if (!isWaitingForDrag(mark)) {
      die(`never reached waiting for RMB drag; persistMark=${mark || "(empty)"}`);
    }

    const before = await readCam(page);
    if (!before) die("window.__qa.getState().camera missing (DEV hook)");
    await page.waitForTimeout(400);
    const settle = await readCam(page);
    if (!settle) die("window.__qa disappeared");
    if (Math.abs(settle.alpha - before.alpha) > 0.02) {
      die(
        `camera.alpha moved before RMB drag (inject?): ${before.alpha.toFixed(4)} → ${settle.alpha.toFixed(4)}`,
      );
    }

    await rmbDragCanvas(page);

    const dragDeadline = Date.now() + 12000;
    while (Date.now() < dragDeadline) {
      mark = await readMark(page);
      if (isTerminalMark(mark)) break;
      await page.waitForTimeout(100);
    }
    const after = await readCam(page);
    if (!after) die("window.__qa missing after drag");
    dAlpha = after.alpha - settle.alpha;
    await page.screenshot({ path: outPath, type: "png" });
    console.log("wrote", outPath);
    console.log(
      `hook dAlpha=${dAlpha.toFixed(4)} inertial=${after.inertialAlphaOffset.toFixed(4)} mark=${mark}`,
    );
  } finally {
    await browser.close();
  }

  if (Math.abs(dAlpha) <= MIN_DALPHA) {
    die(`hook |dAlpha| ${dAlpha.toFixed(4)} ≤ ${MIN_DALPHA} after RMB drag (pointer orbit dead)`);
  }
  const verdict = judgeMark(mark);
  if (!verdict.ok) {
    die(verdict.reason);
  }
  console.log(`OK: RmbOrbitSmoke passed persistMark=${verdict.reason} hook dAlpha=${dAlpha.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
