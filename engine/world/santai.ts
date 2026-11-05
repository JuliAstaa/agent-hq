// Front tier "Santai" (deviation 29): lounge, pantry, game room, nap area, lobby, terrace.
// The furniture is the prototype's floor 1 (references/agent-hq.html), unchanged, authored in its old floor-plan
// coordinates inside one group per room; ROOMS moves each group to its place on the front tier. Wall-mounted pieces
// lost their wall: the TV stands lower on its cabinet, the pantry shelf sits on a backsplash, the PLAY sign on posts.

import * as THREE from "three";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, shade, thin, V, wobble, type CanvasTex } from "../scene/kit";
import { T0, Z_FRONT, Z_RISER_F } from "../layout";
import { alienPlant } from "./props/alienPlant";
import { floorPlane, partition, plankTexture, rail, roomLabel, type Build } from "./structure";

/** Old floor-1 coordinates -> front tier: x + dx, z + dz. */
const ROOMS = {
  lounge: { dx: -15.6, dz: 12.0 },
  pantry: { dx: -9.6, dz: 12.0 },
  game: { dx: 3.0, dz: 12.0 },
  nap: { dx: -15.0, dz: 8.4 },
} as const;

function roomGroup(parent: THREE.Object3D, k: keyof typeof ROOMS) {
  const g = new THREE.Group();
  g.position.set(ROOMS[k].dx, T0, ROOMS[k].dz);
  parent.add(g);
  return g;
}

export interface SantaiProps {
  tv: CanvasTex;
  /** `nozzle` in world-group coordinates (smoke while making coffee). */
  coffee: { btn: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; cup: THREE.Mesh; nozzle: THREE.Vector3 };
  fridge: { door: THREE.Group; light: THREE.Mesh };
  arcade: CanvasTex;
  /** Ball position is set in the game room's old floor-1 coordinates (its parent group). */
  ping: { ball: THREE.Mesh };
  neon: CanvasTex & { draw: () => void };
  sign: CanvasTex & { draw: () => void };
  /** "AGENT HQ" floor emblem in the lobby, drawn once fonts are ready. */
  emblem: CanvasTex & { draw: () => void };
}

export function buildSantai(b: Build, g: THREE.Group, tentacles: THREE.Group[], fonts: Fonts): SantaiProps {
  const { M } = b;
  const { toon, flat } = b.kit;
  const props = {} as SantaiProps;

  // room partitions on the front tier (z from the riser to the street side of the rooms)
  for (const x of [-18.6, -12.6, -4.6, 8.0, 16.0]) partition(b, g, "z", x, Z_RISER_F + 0.4, 9.6, T0);

  // --- Lounge ---
  {
    const g1 = roomGroup(g, "lounge");
    const rug = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#c3a6ff")), false, true);
    rug.rotation.x = -Math.PI / 2; rug.scale.set(4.2, 2.6, 1); rug.position.set(-8, 0.012, -4.8); g1.add(rug);
    const rug2 = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#a98ae6")), false, true);
    rug2.rotation.x = -Math.PI / 2; rug2.scale.set(3.6, 2.1, 1); rug2.position.set(-8, 0.015, -4.8); g1.add(rug2);
    // TV on its cabinet (no back wall any more: the screen stands lower so it hides less of the office behind it)
    boxAt(g1, 4.6, 0.7, 0.8, -8, 0, -7.2, M.wood);
    for (const x of [-9.8, -6.2]) boxAt(g1, 0.12, 0.4, 0.05, x, 0.15, -6.78, M.trim, 0.02);
    boxAt(g1, 4.3, 2.5, 0.22, -8, 0.85, -7.45, M.dark, 0.08);
    const tv = canvasTex(320, 180);
    const scr = mesh(new THREE.PlaneGeometry(3.95, 2.18), noLine(flat("#ffffff", { map: tv.tex })), false, false);
    scr.position.set(-8, 2.1, -7.33); g1.add(scr);
    props.tv = tv;
    // sofa (facing the TV)
    const sofa = new THREE.Group(); sofa.position.set(-8, 0, -3.5); sofa.rotation.y = Math.PI; g1.add(sofa);
    boxAt(sofa, 4.2, 0.45, 1.1, 0, 0.1, 0, M.sofa, 0.12);
    boxAt(sofa, 4.2, 0.95, 0.32, 0, 0.5, -0.45, M.sofa, 0.14);
    for (const s of [-1, 1]) boxAt(sofa, 0.36, 0.75, 1.15, s * 2.0, 0.1, 0, M.sofa, 0.14);
    for (const x of [-1.3, 0, 1.3]) boxAt(sofa, 1.22, 0.16, 0.92, x, 0.55, 0.06, M.sofa2, 0.07);
    for (const s of [-1, 1]) boxAt(sofa, 0.18, 0.1, 0.18, s * 1.9, 0, 0.4, M.dark, 0.03);
    // coffee table
    boxAt(g1, 2.4, 0.1, 0.9, -8, 0.42, -5.7, M.wood, 0.04);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g1, 0.05, 0.05, 0.42, -8 + sx * 1.05, 0, -5.7 + sz * 0.35, M.dark, 8);
    cyl(g1, 0.12, 0.12, 0.08, -8.5, 0.52, -5.7, M.yellow);
    cyl(g1, 0.08, 0.07, 0.16, -7.4, 0.52, -5.6, M.red, 12);
    // beanbags
    for (const [x, z, c] of [[-11.6, -6.2, "#ffd23f"], [-4.4, -6.3, "#59c3ff"]] as const) {
      const bb = mesh(wobble(new THREE.SphereGeometry(0.85, 24, 16), 0.07, x), toon(c));
      bb.scale.set(1, 0.55, 1); bb.position.set(x, 0.42, z); g1.add(bb);
    }
    // lamp
    cyl(g1, 0.25, 0.3, 0.1, -12.0, 0, -3.0, M.dark);
    cyl(g1, 0.04, 0.04, 2.4, -12.0, 0.1, -3.0, M.dark, 8);
    cyl(g1, 0.3, 0.5, 0.55, -12.0, 2.4, -3.0, M.yellow, 16);
    roomLabel(b, g1, "LOUNGE", -8, 0.2, -1.6, "santai");
  }
  // --- Pantry ---
  {
    const g1 = roomGroup(g, "pantry");
    // backsplash behind the counter (the old back wall had a window here)
    boxAt(g1, 6.3, 2.4, 0.16, 0.2, 0, -7.68, toon("#7bd3c0"), 0.04);
    boxAt(g1, 6.0, 1.0, 0.9, 0.2, 0, -7.15, M.teal, 0.06);
    boxAt(g1, 6.1, 0.08, 0.98, 0.2, 1.0, -7.15, M.white, 0.03);
    for (let i = 0; i < 5; i++) boxAt(g1, 0.04, 0.6, 0.02, -2.2 + i * 1.2, 0.2, -6.69, M.dark, 0.01, false);
    // sink
    boxAt(g1, 0.9, 0.06, 0.6, -1.7, 1.05, -7.15, M.steel, 0.03);
    rail(b, g1, V(-1.7, 1.08, -7.45), V(-1.7, 1.5, -7.45), 0.03, M.steel);
    // coffee machine
    const cm = new THREE.Group(); cm.position.set(1.4, 1.08, -7.25); g1.add(cm);
    boxAt(cm, 0.75, 1.0, 0.65, 0, 0, 0, M.red, 0.1);
    boxAt(cm, 0.55, 0.12, 0.3, 0, 0.55, 0.32, M.dark, 0.03);
    boxAt(cm, 0.5, 0.06, 0.32, 0, 0.02, 0.3, M.dark, 0.02);
    const btn = mesh(new THREE.SphereGeometry(0.06, 10, 8), noLine(flat("#a6e22e")), false, false) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    btn.position.set(0.22, 0.8, 0.33); cm.add(btn);
    const cup = cyl(cm, 0.08, 0.07, 0.14, 0, 0.08, 0.3, M.white, 12); cup.visible = false;
    props.coffee = { btn, cup, nozzle: V(1.4 + ROOMS.pantry.dx, T0 + 1.75, -6.95 + ROOMS.pantry.dz) };
    // fridge
    boxAt(g1, 1.1, 2.6, 0.9, 4.2, 0, -7.1, M.white, 0.12);
    const doorPivot = new THREE.Group(); doorPivot.position.set(3.66, 0.05, -6.64); g1.add(doorPivot);
    boxAt(doorPivot, 1.08, 2.5, 0.12, 0.54, 0, 0.06, toon("#e9f3ff"), 0.06);
    rail(b, doorPivot, V(0.95, 1.2, 0.14), V(0.95, 1.9, 0.14), 0.035, M.dark);
    const fl = mesh(new THREE.PlaneGeometry(0.9, 2.3), noLine(flat("#fff9c4")), false, false);
    fl.position.set(4.2, 1.3, -6.66); g1.add(fl);
    props.fridge = { door: doorPivot, light: fl };
    // dining table + stools
    cyl(g1, 0.12, 0.3, 0.9, 0.7, 0, -4.3, M.dark, 14);
    cyl(g1, 0.68, 0.68, 0.08, 0.7, 0.9, -4.3, M.wood, 28);
    cyl(g1, 0.09, 0.07, 0.16, 0.85, 0.98, -4.2, M.lilac, 12);
    for (const x of [-0.55, 1.95]) {
      cyl(g1, 0.06, 0.15, 0.7, x, 0, -4.3, M.dark, 10);
      cyl(g1, 0.32, 0.32, 0.1, x, 0.7, -4.3, M.yellow, 18);
    }
    // shelf with jars, on the backsplash
    boxAt(g1, 2.4, 0.08, 0.35, -1.7, 1.9, -7.45, M.wood, 0.02);
    ([["#ff8fab", -2.5], ["#ffd23f", -1.9], ["#7bdff2", -1.3]] as const).forEach(([c, x]) => cyl(g1, 0.14, 0.14, 0.32, x, 1.98, -7.45, toon(c), 12));
    roomLabel(b, g1, "PANTRY", 0.6, 0.2, -1.6, "santai");
  }
  // --- Game room ---
  {
    const g1 = roomGroup(g, "game");
    const rug = mesh(new THREE.PlaneGeometry(7, 4.6), noLine(toon("#2f2a5a")), false, true);
    rug.rotation.x = -Math.PI / 2; rug.position.set(8.8, 0.012, -5.0); g1.add(rug);
    // arcade
    const ar = new THREE.Group(); ar.position.set(6.6, 0, -7.05); g1.add(ar);
    boxAt(ar, 1.2, 2.4, 1.0, 0, 0, 0, M.teal, 0.08);
    boxAt(ar, 1.24, 0.35, 1.04, 0, 2.15, 0, M.yellow, 0.06);
    const panel = mesh(rbox(1.2, 0.14, 0.55, 0.04), M.dark); panel.position.set(0, 1.12, 0.62); panel.rotation.x = 0.35; ar.add(panel);
    for (const [x, c] of [[-0.25, "#ff4f5e"], [0.05, "#ffd23f"], [0.3, "#a6e22e"]] as const) {
      const bt = mesh(new THREE.SphereGeometry(0.06, 10, 8), noLine(flat(c)), false, false); bt.position.set(x, 1.22, 0.66); ar.add(bt);
    }
    const asc = canvasTex(128, 128);
    const aScreen = mesh(new THREE.PlaneGeometry(0.95, 0.8), noLine(flat("#ffffff", { map: asc.tex })), false, false);
    aScreen.position.set(0, 1.65, 0.52); aScreen.rotation.x = -0.15; ar.add(aScreen);
    props.arcade = asc;
    // ping pong (half table folded up for solo practice)
    const pp = new THREE.Group(); g1.add(pp);
    boxAt(pp, 1.9, 0.08, 1.6, 9.35, 0.9, -5.0, toon("#3a8fd9"), 0.02);
    boxAt(pp, 0.08, 1.9, 1.6, 10.36, 0.98, -5.0, toon("#3a8fd9"), 0.02);
    const lineM = noLine(flat("#ffffff"));
    const l1 = mesh(new THREE.PlaneGeometry(1.9, 0.03), lineM, false, false); l1.rotation.x = -Math.PI / 2; l1.position.set(9.35, 0.985, -5.0); pp.add(l1);
    for (const sz of [-1, 1]) for (const x of [8.6, 10.2]) cyl(pp, 0.05, 0.05, 0.9, x, 0, -5.0 + sz * 0.65, M.dark, 8);
    const ball = mesh(new THREE.SphereGeometry(0.06, 12, 10), toon("#ffffff")); ball.position.set(9.6, 1.0, -4.6); pp.add(ball);
    props.ping = { ball };
    // neon sign, on two posts beside the arcade
    const neon = canvasTex(256, 96) as SantaiProps["neon"];
    neon.draw = () => {
      const c = neon.ctx;
      c.fillStyle = "#1b1530"; c.fillRect(0, 0, 256, 96);
      c.font = `54px ${fonts.bungee}`; c.fillStyle = "#ff6fd8"; c.textAlign = "center"; c.fillText("PLAY", 128, 70);
      neon.tex.needsUpdate = true;
    };
    for (const x of [7.95, 9.25]) cyl(g1, 0.035, 0.035, 2.1, x, 0, -7.5, M.dark, 8);
    const ns = mesh(new THREE.PlaneGeometry(1.8, 0.68), noLine(flat("#ffffff", { map: neon.tex })), false, false);
    ns.position.set(8.6, 2.4, -7.47); g1.add(ns);
    boxAt(g1, 1.92, 0.8, 0.05, 8.6, 2.0, -7.53, M.dark, 0.02);
    props.neon = neon;
    roomLabel(b, g1, "GAME ROOM", 8.2, 0.2, -1.6, "santai");
  }
  // --- Ruang rebahan (in front of the lounge, pillows toward the street) ---
  {
    const g1 = roomGroup(g, "nap");
    for (const [x, c] of [[-11.6, "#ffb3c6"], [-9.3, "#b0f2b4"]] as const) {
      boxAt(g1, 1.45, 0.3, 2.5, x, 0.02, 4.7, toon(c), 0.12);
      boxAt(g1, 1.0, 0.18, 0.5, x, 0.32, 3.75, M.white, 0.08);
      boxAt(g1, 1.35, 0.06, 1.3, x, 0.32, 5.25, toon(shade(c, -0.08)), 0.03);
    }
    cyl(g, 0.35, 0.28, 0.6, -28.0, T0, 13.9, toon("#ff9f68"));
    const bush = mesh(wobble(new THREE.SphereGeometry(0.6, 16, 12), 0.15, 4), M.green); bush.position.set(-28.0, T0 + 1.05, 13.9); g.add(bush);
    roomLabel(b, g, "RUANG REBAHAN", -25.4, T0 + 0.2, 14.3, "santai");
  }
  // --- Lobby (front center, at the foot of the grand stairs): floor emblem, two benches, plant, water cooler ---
  {
    const emblem = canvasTex(512, 512) as SantaiProps["emblem"];
    emblem.draw = () => {
      const c = emblem.ctx;
      c.clearRect(0, 0, 512, 512);
      c.fillStyle = "#ff6fd8"; c.beginPath(); c.arc(256, 256, 252, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#1b1530"; c.beginPath(); c.arc(256, 256, 214, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#ffd23f";
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        c.beginPath(); c.arc(256 + Math.cos(a) * 233, 256 + Math.sin(a) * 233, 7, 0, Math.PI * 2); c.fill();
      }
      c.textAlign = "center"; c.fillStyle = "#fff6e3";
      c.font = `92px ${fonts.bungee}`; c.fillText("AGENT", 256, 250);
      c.fillStyle = "#59c3ff"; c.font = `120px ${fonts.bungee}`; c.fillText("HQ", 256, 360);
      emblem.tex.needsUpdate = true;
    };
    const em = mesh(new THREE.CircleGeometry(2.4, 48), noLine(flat("#ffffff", { map: emblem.tex, transparent: true })), false, true);
    em.rotation.x = -Math.PI / 2; em.position.set(4.4, T0 + 0.014, 12.0); g.add(em);
    props.emblem = emblem;
    for (const x of [-0.6, 9.4]) {
      const bench = new THREE.Group(); bench.position.set(x, T0, 12.4); g.add(bench);
      boxAt(bench, 1.8, 0.16, 0.66, 0, 0.36, 0, toon("#c3a6ff"), 0.06);
      for (const sx of [-0.72, 0.72]) boxAt(bench, 0.14, 0.36, 0.5, sx, 0, 0, M.dark, 0.03);
    }
    alienPlant(b, tentacles, g, -2.8, T0, 13.2);
    boxAt(g, 0.7, 1.1, 0.7, 12.0, T0, 12.8, M.white, 0.08);
    const jug = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 18), thin(toon("#9fe6ff", { transparent: true, opacity: 0.7 })));
    jug.position.set(12.0, T0 + 1.45, 12.8); g.add(jug);
    roomLabel(b, g, "LOBBY", 4.4, T0 + 0.2, 14.4, "santai");
  }
  // vending machines against the riser, right of the game room
  for (const [x, c] of [[17.5, "#ff4f5e"], [18.9, "#59c3ff"]] as const) {
    const vm = new THREE.Group(); vm.position.set(x, T0, Z_RISER_F + 0.5); g.add(vm);
    boxAt(vm, 1.2, 2.2, 0.85, 0, 0, 0, toon(c), 0.08);
    boxAt(vm, 0.8, 1.3, 0.04, -0.12, 0.7, 0.43, toon("#1b1530"), 0.03);
    for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) {
      cyl(vm, 0.07, 0.07, 0.2, -0.36 + k * 0.24, 0.8 + r * 0.3, 0.42, toon(["#ffd23f", "#a6e22e", "#ff6fd8"][(r + k) % 3]), 10);
    }
    boxAt(vm, 0.16, 0.4, 0.05, 0.42, 1.2, 0.44, M.trim, 0.02);
  }
  // welcome sign on the left wall, beside the lounge
  {
    const sign = canvasTex(320, 120) as SantaiProps["sign"];
    sign.draw = () => {
      const c = sign.ctx;
      c.fillStyle = "#ff6fd8"; c.fillRect(0, 0, 320, 120);
      c.fillStyle = "#1b1530"; c.font = `44px ${fonts.bungee}`; c.textAlign = "center"; c.fillText("AGENT HQ", 160, 62);
      c.font = `600 24px ${fonts.fredoka}`; c.fillText("selamat datang", 160, 100);
      sign.tex.needsUpdate = true;
    };
    const sg = mesh(new THREE.PlaneGeometry(2.8, 1.05), noLine(flat("#ffffff", { map: sign.tex })), false, false);
    sg.position.set(-28.35, T0 + 2.9, 7.2); sg.rotation.y = Math.PI / 2; g.add(sg);
    props.sign = sign;
    boxAt(g, 0.08, 1.2, 2.95, -28.4, T0 + 2.3, 7.2, M.dark, 0.03);
  }
  // --- Teras: wooden deck on the front-right corner with a telescope (was the window hall on floor 2) ---
  {
    const X0 = 21.6, X1 = 29.4, Z0 = 8.8, Z1 = Z_FRONT + 0.6;
    const tex = plankTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set((X1 - X0) / 5, (Z1 - Z0) / 5);
    floorPlane(b, g, X0, X1, Z0, Z1, T0 + 0.01, tex);
    const posts = (from: THREE.Vector3, to: THREE.Vector3, n: number) => {
      for (let i = 0; i <= n; i++) {
        const p = from.clone().lerp(to, i / n);
        rail(b, g, p, p.clone().setY(T0 + 1.0), 0.045);
      }
      rail(b, g, from.clone().setY(T0 + 1.0), to.clone().setY(T0 + 1.0), 0.06, M.red);
    };
    posts(V(29.0, T0, Z0 + 0.2), V(29.0, T0, Z1 - 0.4), 6);
    posts(V(X0 + 0.2, T0, Z1 - 0.4), V(29.0, T0, Z1 - 0.4), 6);
    // telescope on a tripod, pointing out and up
    const tg = new THREE.Group(); tg.position.set(28.0, T0, 12.5); g.add(tg);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      rail(b, tg, V(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45), V(0, 1.3, 0), 0.035, M.dark);
    }
    const tube = new THREE.Group(); tube.position.y = 1.35; tube.rotation.z = -1.15; tg.add(tube);
    tube.add(mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.5, 16), toon("#c3a6ff")));
    const lens = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 16), toon("#59c3ff"));
    lens.position.y = 0.78; tube.add(lens);
    cyl(tube, 0.08, 0.08, 0.3, 0, -0.9, 0, M.dark, 10);
    alienPlant(b, tentacles, g, 22.6, T0, 14.0, 0.7);
    roomLabel(b, g, "TERAS", 25.4, T0 + 0.2, 14.3, "santai");
  }
  // plants along the front edge
  for (const [x, z, sc] of [[-19.0, 13.2, 0.8], [-13.4, 13.6, 0.65], [16.6, 13.4, 0.75]] as const) alienPlant(b, tentacles, g, x, T0, z, sc);
  return props;
}
