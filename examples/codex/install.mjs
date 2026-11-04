#!/usr/bin/env node
// Installs the Agent HQ hook for OpenAI Codex (docs/codex.md). Node.js 18+, built-in modules only.
//
// - copies hq_codex.mjs to <codex home>/agent-hq/ and creates agent-hq.env there if missing;
// - adds one handler per event to <codex home>/hooks.json (backup first). Other hooks are kept.
// Safe to run again: earlier Agent HQ handlers are replaced, never doubled.
//
//   node examples/codex/install.mjs                     # install for all projects (~/.codex)
//   node examples/codex/install.mjs --url http://127.0.0.1:9787
//   node examples/codex/install.mjs --print             # show the hooks.json block, change nothing
//   node examples/codex/install.mjs --uninstall         # remove the Agent HQ handlers and files
//   options: --codex-home <dir> (default $CODEX_HOME or ~/.codex), --node <path to node>

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS } from "./hq_codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = "hq_codex.mjs";
// SessionEnd and Interrupt allow at most 3 seconds (Codex docs); the others get a little more room.
const TIMEOUT = { SessionEnd: 3, Interrupt: 3 };

function parseArgs(argv) {
  const opts = { codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), url: "", node: "", print: false, uninstall: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--print") opts.print = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--codex-home") opts.codexHome = argv[++k];
    else if (a === "--url") opts.url = argv[++k];
    else if (a === "--node") opts.node = argv[++k];
    else throw new Error(`pilihan tidak dikenal: ${a}`);
  }
  if (!opts.codexHome) throw new Error("--codex-home butuh folder");
  opts.codexHome = path.resolve(opts.codexHome.replace(/^~(?=$|[\\/])/, os.homedir()));
  return opts;
}

const slash = (p) => p.split(path.sep).join("/");

/** Shell command Codex runs: `sh -lc` on macOS/Linux, `cmd /C` on Windows. */
export function hookCommand(scriptPath, node = "", platform = process.platform) {
  const script = `"${slash(scriptPath)}"`;
  if (node) return `"${slash(node)}" ${script}`;
  // Windows: Node's installer puts node on PATH, and cmd mangles a quoted program path followed by more quotes.
  return platform === "win32" ? `node ${script}` : `"${process.execPath}" ${script}`;
}

const isOurs = (handler) => typeof handler?.command === "string" && handler.command.includes(SCRIPT);

/** hooks.json content without Agent HQ handlers; groups and events left empty are dropped. */
export function withoutOurs(doc) {
  const out = doc && typeof doc === "object" && !Array.isArray(doc) ? { ...doc } : {};
  const hooks = out.hooks && typeof out.hooks === "object" ? { ...out.hooks } : {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  out.hooks = hooks;
  return out;
}

/** hooks.json content with exactly one Agent HQ handler per event. */
export function withOurs(doc, command) {
  const out = withoutOurs(doc);
  for (const ev of EVENTS) {
    const group = { hooks: [{ type: "command", command, timeout: TIMEOUT[ev] || 5 }] };
    out.hooks[ev] = [...(out.hooks[ev] || []), group];
  }
  return out;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} bukan JSON yang valid (${e.message}). Perbaiki dulu; tidak ada yang diubah.`);
  }
}

function writeWithBackup(file, content) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === content) return null;
  let backup = null;
  if (before !== null) {
    backup = `${file}.agent-hq-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.bak`;
    fs.writeFileSync(backup, before);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return backup;
}

function setEnvLine(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  const line = `${key}=${value}`;
  fs.writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
}

function health(url) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url.replace(/\/+$/, "").replace(/\/api$/, "") + "/api/health");
    } catch {
      resolve(false);
      return;
    }
    const req = (u.protocol === "https:" ? https : http).get(u, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/** features.hooks = false in config.toml turns every hook off. */
function hooksDisabled(codexHome) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return false;
  }
  const features = text.match(/^\[features\][^[]*/m)?.[0] || "";
  return /^\s*(codex_)?hooks\s*=\s*false\b/m.test(features) || /^\s*features\.(codex_)?hooks\s*=\s*false\b/m.test(text);
}

async function main(argv) {
  const opts = parseArgs(argv);
  const dir = path.join(opts.codexHome, "agent-hq");
  const hooksFile = path.join(opts.codexHome, "hooks.json");
  const command = hookCommand(path.join(dir, SCRIPT), opts.node);

  if (opts.print) {
    process.stdout.write(JSON.stringify(withOurs({}, command), null, 2) + "\n");
    return 0;
  }

  if (opts.uninstall) {
    const backup = fs.existsSync(hooksFile)
      ? writeWithBackup(hooksFile, JSON.stringify(withoutOurs(readJson(hooksFile)), null, 2) + "\n")
      : null;
    fs.rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`Hook Agent HQ dicopot dari ${hooksFile}${backup ? ` (cadangan: ${path.basename(backup)})` : ""}.\n`);
    return 0;
  }

  const doc = readJson(hooksFile); // fails before anything is copied when hooks.json is broken
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(HERE, SCRIPT), path.join(dir, SCRIPT));
  const envFile = path.join(dir, "agent-hq.env");
  if (!fs.existsSync(envFile)) fs.copyFileSync(path.join(HERE, "agent-hq.env.example"), envFile);
  if (opts.url) setEnvLine(envFile, "HQ_URL", opts.url.replace(/\/+$/, ""));
  const backup = writeWithBackup(hooksFile, JSON.stringify(withOurs(doc, command), null, 2) + "\n");

  const url = opts.url || (fs.readFileSync(envFile, "utf8").match(/^HQ_URL=(.+)$/m)?.[1] ?? "http://127.0.0.1:8787").trim();
  const up = await health(url);
  const lines = [
    "Agent HQ untuk Codex terpasang.",
    `  skrip   : ${path.join(dir, SCRIPT)}`,
    `  setting : ${envFile}`,
    `  hooks   : ${hooksFile} (${EVENTS.length} event${backup ? `, cadangan ${path.basename(backup)}` : ""})`,
    `  Agent HQ: ${url} ${up ? "terjangkau" : "BELUM terjangkau (nyalakan dulu: npm run dev atau npm start)"}`,
    "",
    "Langkah berikutnya:",
    "  1. Jalankan `codex`, ketik /hooks, lalu percayai (trust) semua hook hq_codex.mjs.",
    "     Codex melewati hook baru sampai dipercaya, juga di `codex exec` dan ekstensi VS Code.",
    `  2. Tes tanpa Codex: node "${path.join(dir, SCRIPT)}" --test`,
  ];
  if (hooksDisabled(opts.codexHome)) {
    lines.push("", `PERINGATAN: config.toml mematikan hook ([features] hooks = false). Hapus baris itu dulu.`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`agent-hq: ${e.message}\n`);
      process.exit(1);
    },
  );
}
