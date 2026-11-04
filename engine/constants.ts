// Pure engine constants, ported from references/agent-hq.html. No mutable state here.

export const INK = "#1b1530";
/** Floor heights (prd.md §9). */
export const F2 = 5.6;
export const F3 = 11.2;
/** Meeting floor (prd.md §7.9). */
export const F4 = 16.8;
/** Seconds an agent stays idle at its desk before strolling to a lounge spot. */
export const IDLE_LEAVE_DELAY = 3;

export type Activity =
  | "tv" | "phone" | "lie_phone" | "nap" | "coffee" | "fridge" | "sip" | "arcade" | "pingpong"
  | "gaze" | "whiteboard" | "cards" | "read";

export const ACT_LABEL: Record<Activity, string> = {
  tv: "nonton TV", phone: "main HP di sofa", lie_phone: "rebahan sambil main HP", nap: "tidur siang",
  coffee: "bikin kopi", fridge: "nyari camilan", sip: "ngopi santai", arcade: "main arcade", pingpong: "main pingpong",
  gaze: "bengong lihat planet", whiteboard: "corat-coret whiteboard", cards: "main kartu", read: "baca buku",
};

export const SHAPES = ["blob", "bot", "tall"] as const;
export type Shape = (typeof SHAPES)[number];
export const ACCESSORIES = ["none", "hardhat", "headphones", "horns", "glasses", "none"] as const;

type View = { pos: [number, number, number]; target: [number, number, number] };
/** Camera presets per floor mode. [position, target] */
export const VIEWS: Record<"all" | "1" | "2" | "3" | "4", View> = {
  // Semua frames four floors (prd.md §7.9); the prototype's three-floor pose is VIEW_ALL_3.
  all: { pos: [34.5, 37.8, 43], target: [2.6, 10, 0.6] },
  "4": { pos: [22, 34.6, 25], target: [2.2, 16.8, -0.2] },
  "3": { pos: [22, 29, 25], target: [2.2, 11.2, -0.2] },
  "2": { pos: [22, 23, 25], target: [2.2, 5.6, -0.2] },
  "1": { pos: [10, 16.5, 27.5], target: [2.6, 0.4, -1.2] },
};
/** Semua without the meeting floor (prototype pose; engine.debug.hideMeetingFloor). */
export const VIEW_ALL_3: View = { pos: [30, 30, 37], target: [2.6, 6.2, 0.6] };

export const RED_NODES: Record<string, [number, number]> = { RED: [90, 150], WEB: [300, 80], API: [300, 200], SSH: [500, 70], DB: [520, 200], ADMIN: [680, 135] };
export const RED_EDGES: [string, string][] = [["RED", "WEB"], ["RED", "API"], ["WEB", "SSH"], ["API", "DB"], ["WEB", "ADMIN"], ["API", "ADMIN"]];

export const TERM = ["$ nmap -sV -p- target", "PORT     STATE SERVICE", "22/tcp   open  ssh", "80/tcp   open  http", "443/tcp  open  https", "$ ffuf -w common.txt -u /FUZZ", "/admin   [403]", "/backup  [200]", "$ sqlmap -u /login --batch", "[!] parameter rentan", "$ hydra -L users -P pass ssh", "[*] uji kredensial lemah"];
export const SOCLOG = ["sshd: Failed password for root", "sshd: Invalid user admin", "nginx: POST /wp-login.php 401", "fail2ban: Ban 103.94.12.7", "auth: 3 gagal / 10 dtk", "nginx: GET /.env 404"];
