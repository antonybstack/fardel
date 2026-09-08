#!/usr/bin/env node
/**
 * RmbOrbitSmoke (#366): Playwright ?ve=rmb-orbit on a *seat* Vite + seat db.
 * Exit 0 iff #persistMark matches /^RMB orbit OK/.
 * Exit non-zero on RMB orbit FAIL / empty / timeout.
 * Never :3000 / :5173 / db fardel / play.sparkify.dev.
 *
 *   FARDEL_VITE_PORT FARDEL_DB FARDEL_SPACETIME_URI node tools/qa/rmb-orbit-smoke.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const PROD_STDB_PORT = "3000";
const PROD_VITE_PORT = "5173";
const PROD_DB = "fardel";
const TIMEOUT_MS = Number(process.env.RMB_ORBIT_SMOKE_TIMEOUT_MS || "45000");

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
    ["VE rmb-orbit: connected…", false],
    ["RMB orbit FAIL · dAlpha 0.000", false],
    ["RMB orbit OK · dAlpha 0.182", true],
  ];
  for (const [mark, want] of cases) {
    const got = judgeMark(mark).ok;
    if (got !== want) {
      die(`self-check judgeMark(${JSON.stringify(mark)}) got ${got} want ${want}`);
    }
  }
}

async function main() {
  selfCheckJudge();
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
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      mark = await page.evaluate(() => document.getElementById("persistMark")?.textContent?.trim() ?? "");
      if (isTerminalMark(mark)) break;
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: outPath, type: "png" });
    console.log("wrote", outPath);
  } finally {
    await browser.close();
  }

  const verdict = judgeMark(mark);
  if (!verdict.ok) {
    die(verdict.reason);
  }
  console.log(`OK: RmbOrbitSmoke passed persistMark=${verdict.reason}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
