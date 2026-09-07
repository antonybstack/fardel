import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/package.json"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadWs() {
  try {
    return require("ws");
  } catch {
    const { execSync } = await import("child_process");
    execSync("npm install --no-save ws@8", {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web"),
      stdio: "inherit",
    });
    return require("ws");
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
  });
}

async function waitCdp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson("http://127.0.0.1:" + port + "/json/list");
      const page = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error("page CDP not ready on " + port);
}

async function chromeShot(WebSocket, url, outPath, waitMs) {
  const userData = "/tmp/chrome-ve-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  fs.mkdirSync(userData, { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,800",
      "--user-data-dir=" + userData,
      "--remote-debugging-port=" + port,
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const wsUrl = await waitCdp(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) => {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    };

    await send("Page.enable");
    await sleep(waitMs);
    const evalRes = await send("Runtime.evaluate", {
      expression: "document.getElementById('persistMark')?.textContent || ''",
      returnByValue: true,
    });
    const mark = evalRes.result?.value ?? "";
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    ws.close();
    return mark;
  } finally {
    try { chrome.kill("SIGKILL"); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }
}

const url = process.argv[2];
const outPath = process.argv[3];
const waitMs = Number(process.argv[4] || 9000);
if (!url || !outPath) {
  console.error("usage: ve-chrome-shot.mjs <url> <out.png> [waitMs]");
  process.exit(2);
}
const WebSocket = await loadWs();
const mark = await chromeShot(WebSocket, url, outPath, waitMs);
console.log("mark:", mark);
console.log("wrote", outPath, fs.statSync(outPath).size);
