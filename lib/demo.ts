// Demo simulator (port of startSim/stopSim in references/agent-hq.html). Drives the store with fake events.

import type { HQStore } from "./store";

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// 9 demo agents to match the 9 desks (deviation 17; the prototype had 11, Fizzle and Nubb are gone).
/** Demo agents that start out working (the rest start idle and head for the lounge). */
const DEMO_WORKING = new Set(["zorp", "glimbo", "krunch", "rexx", "quill", "sentra"]);
export const DEMO = [
  { id: "zorp", name: "Zorp", role: "Researcher", tasks: ["Merangkum 14 paper soal RAG", "Membandingkan vector DB", "Benchmark latency Go vs Rust", "Membaca changelog Laravel 12"] },
  { id: "glimbo", name: "Glimbo", role: "Coder", tasks: ["Refactor handler auth (Gofiber)", "Migration tabel transaksi", "Endpoint /v1/reports", "Fix race condition di worker"] },
  { id: "plonk", name: "Plonk", role: "QA Tester", tasks: ["Menjalankan 42 unit test", "Fuzzing form login", "Regression test modul nilai", "Cek coverage service payment"] },
  { id: "vexa", name: "Vexa", role: "Writer", tasks: ["Menulis dokumentasi API", "Draft changelog v2.3", "Menyusun README deploy", "Merapikan docstring util"] },
  { id: "mib", name: "Mib", role: "Data Analyst", tasks: ["Ringkasan pengeluaran bulanan", "Bersihkan dataset 12k baris", "Grafik retensi user", "Cari anomali log Nginx"] },
  { id: "krunch", name: "Krunch", role: "DevOps", tasks: ["Build image Docker multi-stage", "Rolling deploy ke staging", "Rotasi sertifikat TLS", "Tuning worker_processes Nginx"] },
  { id: "rexx", name: "Rexx", role: "Red Team", tasks: ["Recon subdomain target", "Scan port & service (nmap)", "Uji SQL injection di /login", "Cek IDOR di API booking", "Uji bruteforce form login (scope)"] },
  { id: "quill", name: "Quill", role: "VA Reporter", tasks: ["Laporan VA: executive summary", "Hitung skor CVSS temuan", "Tulis rekomendasi remediasi", "Rapikan bukti PoC"] },
  { id: "sentra", name: "Sentra", role: "SOC Analyst", tasks: ["Monitor SIEM: login gagal SSH", "Deteksi bruteforce /wp-login", "Blokir IP via fail2ban", "Threat hunting log Nginx"] },
] as const;

const ERRORS = ["Timeout saat panggil API eksternal", "Test gagal: 3/42", "Rate limit 429 dari provider", "Permission denied: /var/www", "Container exit code 137 (OOM)"];
const FINDINGS: [string, string][] = [["high", "SQL injection di /login"], ["medium", "IDOR di /api/booking/{id}"], ["critical", "RCE via upload avatar"], ["low", "Header keamanan tidak lengkap"], ["medium", "Directory listing /backup"], ["info", "Versi Nginx terekspos"], ["high", "Panel admin tanpa rate limit"], ["medium", "SSH izinkan password login"]];
const ALERTS: [string, string][] = [["Bruteforce SSH 412x / 2 mnt", "103.94.12.7"], ["Credential stuffing /wp-login.php", "45.13.220.9"], ["Bruteforce panel admin", "185.220.101.4"], ["Lonjakan 401 di /api/auth", "36.72.15.88"]];
/** Meeting floor (prd.md §7.9): Glimbo's demo subagents, and the group Plonk and Vexa share for one task. */
const SUB_NAMES = ["Penjelajah", "Penguji", "Peninjau"];
const SUB_TASKS = ["Cari pemanggil fungsi auth", "Jalankan test modul transaksi", "Review diff handler", "Baca dokumentasi Gofiber", "Cek query yang lambat"];
const DELEGATIONS = ["Delegasi: audit modul auth", "Delegasi: siapkan rilis worker", "Delegasi: cari sumber race condition"];
export const DEMO_GROUP = "Rilis v2.3";
const WAITS = ["Minta persetujuan sebelum push ke main", "Perlu API key staging", "Konfirmasi hapus 230 file lama?", "Pilih: soft delete atau arsip?"];

export interface Demo {
  start: () => void;
  stop: () => void;
  readonly running: boolean;
}

export function createDemo(store: HQStore): Demo {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const S = () => store.getState();
  const apply = (ev: Record<string, unknown>) => S().applyEvent(ev);
  // One-shot timers of the demo subagents (cleared by stop()).
  const later = new Set<ReturnType<typeof setTimeout>>();
  const after = (ms: number, fn: () => void) => {
    const h = setTimeout(() => {
      later.delete(h);
      fn();
    }, ms);
    later.add(h);
  };
  let subSeq = 0;
  /** Glimbo hands parts of its task to 2 or 3 subagents: each works 20-45 s, is done, and leaves 8 s later. */
  const delegate = () => {
    if (!S().agents.has("glimbo") || [...S().agents.values()].some((a) => a.parent === "glimbo")) return;
    apply({ id: "glimbo", status: "working", task: pick(DELEGATIONS) });
    const n = Math.random() < 0.5 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const id = `glimbo-sub-${++subSeq}`;
      after(500 + k * 900, () => {
        apply({ id, name: SUB_NAMES[k], role: "Subagen · demo", parent: "glimbo", status: "working", task: pick(SUB_TASKS) });
        after(20000 + Math.random() * 25000, () => {
          apply({ type: "task_done", id, status: "idle", tokens_delta: 300 + Math.floor(Math.random() * 900) });
          after(8000, () => apply({ type: "remove", id }));
        });
      });
    }
  };
  /** Plonk and Vexa work on the release together (one task each, then the group is cleared). */
  const groupUp = () => {
    apply({ id: "plonk", group: DEMO_GROUP, status: "working", task: "Regression test rilis v2.3", progress: 0.05 });
    apply({ id: "vexa", group: DEMO_GROUP, status: "working", task: "Draft changelog v2.3", progress: 0.05 });
  };

  const tick = () => {
    const d = pick(DEMO);
    const a = S().agents.get(d.id);
    if (!a) {
      timer = setTimeout(tick, 1500);
      return;
    }
    const r = Math.random();
    if (a.status === "working") {
      const p = Math.min(1, (a.progress ?? 0) + 0.15 + Math.random() * 0.2);
      if (p >= 1) {
        apply({ type: "task_done", id: d.id, status: "idle", task: a.task, tokens_delta: 400 });
        if (a.group) for (const id of ["plonk", "vexa"]) apply({ id, group: null });
      }
      else if (r < 0.07) apply({ id: d.id, status: "error", task: a.task });
      else if (r < 0.14) apply({ id: d.id, status: "waiting", task: pick(WAITS) });
      else if (r < 0.28) apply({ id: d.id, status: "thinking", progress: p });
      else apply({ id: d.id, progress: p, tokens_delta: 300 + Math.floor(Math.random() * 1500) });
      if (r > 0.78) apply({ type: "log", id: d.id, level: "info", message: pick(["Tool call: read_file", "Tool call: run_tests", "Tool call: web_search", "Tool call: bash"]) });
      if (d.id === "rexx" && Math.random() < 0.4) {
        const [sev, title] = pick(FINDINGS);
        apply({ type: "finding", id: "rexx", severity: sev, title });
      }
      if (d.id === "sentra" && Math.random() < 0.35) {
        const [msg, ip] = pick(ALERTS);
        apply({ type: "alert", id: "sentra", severity: pick(["high", "high", "critical", "medium"]), message: msg, source_ip: ip });
      }
      if (d.id === "quill" && Math.random() < 0.3) apply({ type: "log", id: "quill", level: "info", message: "Menambahkan temuan ke draf laporan" });
    } else if (a.status === "error") {
      apply({ type: "log", id: d.id, level: "error", message: pick(ERRORS) });
      apply({ id: d.id, status: r < 0.7 ? "working" : "offline" });
    } else if (a.status === "thinking") {
      apply({ id: d.id, status: "working", tokens_delta: 800 });
    } else if (a.status === "waiting") {
      if (r < 0.5) apply({ id: d.id, status: "working", task: a.task });
    } else if (a.status === "offline") {
      if (r < 0.5) apply({ id: d.id, status: "idle", task: "Restart, menunggu tugas" });
    } else if (r < 0.2) {
      const vexa = S().agents.get("vexa");
      if (d.id === "plonk" && vexa?.status === "idle" && Math.random() < 0.5) groupUp();
      else {
        apply({ id: d.id, status: "working", task: pick(d.tasks), progress: 0.05 });
        if (d.id === "glimbo" && Math.random() < 0.5) delegate();
      }
    }
    timer = setTimeout(tick, 900 + Math.random() * 1600);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const h of later) clearTimeout(h);
    later.clear();
  };

  const start = () => {
    stop();
    S().clearAgents();
    apply({
      type: "snapshot",
      agents: DEMO.map((d, i) => ({
        id: d.id, name: d.name, role: d.role,
        status: DEMO_WORKING.has(d.id) ? "working" : "idle",
        task: d.tasks[0], tokens: 2000 + i * 1700, progress: 0.1 + i * 0.08,
      })),
    });
    S().pushLog({ id: "krunch", message: "Mode demo aktif. Klik agen untuk zoom, pilih area di atas." });
    timer = setTimeout(tick, 2500);
    after(6000, delegate); // show the meeting floor early in the demo
    S().setConn("demo");
  };

  return {
    start,
    stop,
    get running() {
      return timer != null;
    },
  };
}
