#!/usr/bin/env node
/**
 * Drive one claimed agent seat with Playwright.
 * Never opens play.sparkify.dev or :3000 / db fardel.
 *
 *   node tools/qa/play.mjs --seat qa-1 screenshot
 *   node tools/qa/play.mjs --seat qa-1 move --key w --ms 800
 */
import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";


const PROD_STDB_PORT = "3000";
const PROD_VITE_PORT = "5173";
const PROD_DB = "fardel";

function die(msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { seat: "", cmd: "screenshot", key: "w", ms: 800, out: "", headed: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seat") out.seat = argv[++i] ?? "";
    else if (a === "--key") out.key = argv[++i] ?? "w";
    else if (a === "--ms") out.ms = Number(argv[++i] ?? "800");
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--headed") out.headed = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else rest.push(a);
  }
  if (rest[0]) out.cmd = rest[0];
  return out;
}

function loadClaim(seat) {
  const file = path.join(os.homedir(), ".local/share/fardel-seats/claims", seat);
  if (!fs.existsSync(file)) die(`seat ${seat} is not claimed (${file})`);
  const claim = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("=")) continue;
    const i = line.indexOf("=");
    claim[line.slice(0, i)] = line.slice(i + 1);
  }
  return claim;
}

function assertNotProd(claim, url) {
  const stdb = String(claim.spacetime_port || "");
  const vite = String(claim.vite_port || "");
  const db = String(claim.db || "");
  const uri = String(claim.uri || "");
  if (stdb === PROD_STDB_PORT || vite === PROD_VITE_PORT || db === PROD_DB) {
    die(`refusing prod/lead surface stdb=${stdb} vite=${vite} db=${db}`, 2);
  }
  if (uri.includes(`:${PROD_STDB_PORT}`) || uri.includes("dev-db.sparkify.dev")) {
    die(`refusing prod URI ${uri}`, 2);
  }
  if (url.includes("play.sparkify.dev") || url.includes(`:${PROD_VITE_PORT}`)) {
    die(`refusing prod/lead URL ${url}`, 2);
  }
}

function clientUrl(claim) {
  if (claim.client_url) return claim.client_url;
  return `http://127.0.0.1:${claim.vite_port}/?db=${claim.uri}&module=${claim.db}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help" || !args.seat) {
    console.log(`usage: node play.mjs --seat <slug> [screenshot|move|state] [--key w] [--ms 800] [--out file.png]
  screenshot  wait for __qa connected, write PNG
  move        __qa.holdMove then screenshot
  state       print window.__qa.getState()`);
    process.exit(args.seat ? 0 : 1);
  }

  const claim = loadClaim(args.seat);
  const url = clientUrl(claim);
  assertNotProd(claim, url);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artDir = claim.artifact_dir || path.join(os.homedir(), "dev/fardel-artifacts", args.seat);
  fs.mkdirSync(artDir, { recursive: true });
  const outPath = args.out || path.join(artDir, `${stamp}_${args.cmd}.png`);
  const profile = claim.playwright_profile || path.join(os.homedir(), ".local/share/fardel-seats/profiles", args.seat);
  fs.mkdirSync(profile, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    headless: !args.headed,
    viewport: { width: 1280, height: 800 },
    args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!window.__qa, { timeout: 20000 });
    await page.waitForFunction(() => window.__qa?.getState()?.connected === true, {
      timeout: 25000,
    });
    await page.waitForFunction(
      () => {
        const el = document.getElementById("status");
        return !!(el && /connected/i.test(el.textContent || ""));
      },
      { timeout: 15000 },
    );

    if (args.cmd === "move") {
      const key = args.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key)) die(`bad --key ${args.key}`);
      await page.evaluate(
        async ({ dir, ms }) => {
          await window.__qa.holdMove(dir, ms);
        },
        { dir: key, ms: args.ms },
      );
    }

    // Give Babylon a couple of frames; headless WebGL canvas can be empty
    // on the first tick even when the HUD already says Connected.
    await page.waitForTimeout(2000);

    const state = await page.evaluate(() => window.__qa.getState());
    fs.writeFileSync(
      path.join(artDir, `${stamp}_meta.json`),
      JSON.stringify({ seat: args.seat, url, claim, state, at: stamp }, null, 2),
    );

    if (args.cmd === "state") {
      console.log(JSON.stringify(state, null, 2));
    } else {
      await page.screenshot({ path: outPath, type: "png" });
      console.log("wrote", outPath);
    }
    console.log("state", state.uri, state.database, "id", state.identityHex);
    if (state.database === PROD_DB || String(state.uri).includes(`:${PROD_STDB_PORT}`)) {
      die("page connected to prod — abort", 2);
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
