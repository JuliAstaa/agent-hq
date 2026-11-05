// Pure engine constants, ported from references/agent-hq.html. No mutable state here.

export const INK = "#1b1530";
/** Tier heights and camera presets of the single-floor layout live in ./layout.ts (deviation 29). */

/** Seconds an agent stays idle at its desk before strolling to a lounge spot. */
export const IDLE_LEAVE_DELAY = 3;

export type Activity =
  | "tv" | "phone" | "lie_phone" | "nap" | "coffee" | "fridge" | "sip" | "arcade" | "pingpong"
  | "gaze" | "whiteboard" | "cards" | "read" | "park";

export const ACT_LABEL: Record<Activity, string> = {
  tv: "nonton TV", phone: "main HP di sofa", lie_phone: "rebahan sambil main HP", nap: "tidur siang",
  coffee: "bikin kopi", fridge: "nyari camilan", sip: "ngopi santai", arcade: "main arcade", pingpong: "main pingpong",
  gaze: "bengong lihat planet", whiteboard: "corat-coret whiteboard", cards: "main kartu", read: "baca buku",
  park: "nongkrong di bangku",
};

export const SHAPES = ["blob", "bot", "tall"] as const;
export type Shape = (typeof SHAPES)[number];
export const ACCESSORIES = ["none", "hardhat", "headphones", "horns", "glasses", "none"] as const;

export const RED_NODES: Record<string, [number, number]> = { RED: [90, 150], WEB: [300, 80], API: [300, 200], SSH: [500, 70], DB: [520, 200], ADMIN: [680, 135] };
export const RED_EDGES: [string, string][] = [["RED", "WEB"], ["RED", "API"], ["WEB", "SSH"], ["API", "DB"], ["WEB", "ADMIN"], ["API", "ADMIN"]];

export const TERM = ["$ nmap -sV -p- target", "PORT     STATE SERVICE", "22/tcp   open  ssh", "80/tcp   open  http", "443/tcp  open  https", "$ ffuf -w common.txt -u /FUZZ", "/admin   [403]", "/backup  [200]", "$ sqlmap -u /login --batch", "[!] parameter rentan", "$ hydra -L users -P pass ssh", "[*] uji kredensial lemah"];
export const SOCLOG = ["sshd: Failed password for root", "sshd: Invalid user admin", "nginx: POST /wp-login.php 401", "fail2ban: Ban 103.94.12.7", "auth: 3 gagal / 10 dtk", "nginx: GET /.env 404"];
/** DevOps station terminal (server room, deviation 29). */
export const OPSLOG = ["$ docker compose up -d", "api  Started", "worker  Started", "$ kubectl rollout status deploy/api", "deployment \"api\" 3/3 ready", "$ nginx -t", "syntax is ok", "$ systemctl reload nginx", "$ terraform plan", "Plan: 2 to add, 0 to destroy"];
