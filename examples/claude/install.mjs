#!/usr/bin/env node
// Adds the Agent HQ hooks (examples/claude-hooks.settings.json) to a Claude Code settings.json (docs/claude.md).
// Node.js 18+, built-in modules only, works the same on Windows, macOS, and Linux (no jq needed).
//
// Other settings and other hooks are kept, the old file is backed up first, and running it again replaces the
// Agent HQ hooks instead of doubling them.
//
//   node examples/claude/install.mjs                        # all projects: ~/.claude/settings.json
//   node examples/claude/install.mjs --project ../shop-api  # one project: <dir>/.claude/settings.json
//   node examples/claude/install.mjs --url http://127.0.0.1:9787
//   node examples/claude/install.mjs --print                # show the merged hooks, change nothing
//   node examples/claude/install.mjs --uninstall            # remove only the Agent HQ hooks
//   option: --settings <file> (any settings file, for example .claude/settings.local.json)

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, "..", "claude-hooks.settings.json");
const DEFAULT_URL = "http://127.0.0.1:8787";

function parseArgs(argv) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const opts = { settings: path.join(configDir, "settings.json"), url: "", print: false, uninstall: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--print") opts.print = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--settings") opts.settings = argv[++k];
    else if (a === "--project") opts.settings = path.join(argv[++k] || ".", ".claude", "settings.json");
    else if (a === "--url") opts.url = String(argv[++k] || "").replace(/\/+$/, "").replace(/\/api$/, "");
    else throw new Error(`pilihan tidak dikenal: ${a}`);
  }
  if (!opts.settings) throw new Error("--settings butuh path file");
  opts.settings = path.resolve(opts.settings.replace(/^~(?=$|[\\/])/, os.homedir()));
  return opts;
}

/** An Agent HQ hook: an http handler that posts to /api/hook (or the old /hook) of Agent HQ. */
export function isOurs(handler) {
  if (!handler || handler.type !== "http" || typeof handler.url !== "string") return false;
  let u;
  try {
    u = new URL(handler.url);
  } catch {
    return false;
  }
  if (!/^\/(api\/)?hook\/?$/.test(u.pathname)) return false;
  const headers = Object.keys(handler.headers || {}).map((k) => k.toLowerCase());
  return headers.includes("x-hq-name") || u.port === "8787";
}

/** Settings without Agent HQ hooks; groups and events left empty are dropped. */
export function withoutOurs(settings) {
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...settings } : {};
  if (!out.hooks || typeof out.hooks !== "object") return out;
  const hooks = { ...out.hooks };
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

/** Settings with the example's Agent HQ hooks, once per event, pointing at `url`. */
export function withOurs(settings, example, url = DEFAULT_URL) {
  const out = withoutOurs(settings);
  const hooks = { ...(out.hooks || {}) };
  for (const [ev, groups] of Object.entries(example.hooks || {})) {
    const ours = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => (h.type === "http" ? { ...h, url: h.url.replace(DEFAULT_URL, url) } : h)),
    }));
    hooks[ev] = [...(hooks[ev] || []), ...ours];
  }
  out.hooks = hooks;
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
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${file} bukan JSON yang valid (${e.message}). Perbaiki dulu; tidak ada yang diubah.`);
  }
}

function writeWithBackup(file, content) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === content) return { changed: false, backup: null };
  let backup = null;
  if (before !== null) {
    backup = `${file}.agent-hq-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.bak`;
    fs.writeFileSync(backup, before);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { changed: true, backup };
}

function health(url) {
  return new Promise((resolve) => {
    const u = new URL(url + "/api/health");
    const req = (u.protocol === "https:" ? https : http).get(u, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function main(argv) {
  const opts = parseArgs(argv);
  const url = opts.url || DEFAULT_URL;
  new URL(url); // a bad --url fails here, before anything is written
  const example = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  const current = readJson(opts.settings);
  const next = opts.uninstall ? withoutOurs(current) : withOurs(current, example, url);
  const text = JSON.stringify(next, null, 2) + "\n";

  if (opts.print) {
    // Only the hooks: the rest of settings.json can hold secrets (env, apiKeyHelper).
    process.stdout.write(JSON.stringify({ hooks: next.hooks || {} }, null, 2) + "\n");
    return 0;
  }
  if (opts.uninstall && !fs.existsSync(opts.settings)) {
    process.stdout.write(`${opts.settings} tidak ada, tidak ada yang dicopot.\n`);
    return 0;
  }
  const { changed, backup } = writeWithBackup(opts.settings, text);
  const note = backup ? ` (cadangan: ${path.basename(backup)})` : changed ? "" : " (tidak berubah)";
  if (opts.uninstall) {
    process.stdout.write(`Hook Agent HQ dicopot dari ${opts.settings}${note}.\n`);
    return 0;
  }
  const up = await health(url);
  process.stdout.write(
    [
      "Hook Agent HQ untuk Claude Code terpasang.",
      `  setting : ${opts.settings}${note}`,
      `  event   : ${Object.keys(example.hooks).length}, dikirim ke ${url}/api/hook`,
      `  Agent HQ: ${up ? "terjangkau" : "BELUM terjangkau (nyalakan dulu: npm run dev atau npm start)"}`,
      "",
      "Buka sesi `claude` baru. Sesi yang sudah jalan memakai hook lama; kalau Claude Code memberi tahu",
      "hook berubah, buka /hooks untuk memuatnya.",
    ].join("\n") + "\n",
  );
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
