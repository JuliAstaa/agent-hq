// Floor 1 "Santai": island, ground floor shell, lounge, pantry, game room, ruang rebahan, lobby.
// Ported 1:1 from references/agent-hq.html.

import * as THREE from "three";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, shade, thin, V, wobble, type CanvasTex } from "../scene/kit";
import { alienPlant } from "./props/alienPlant";
import { floorPlane, floorTexture, makeWall, partition, rail, roomLabel, type Build } from "./structure";

export function buildIslandAndFloor1Shell(b: Build, world: THREE.Group, g1: THREE.Group) {
  const { M } = b;
  const { toon } = b.kit;
  world.add(mesh(rbox(28.4, 0.8, 18.4, 0.22), M.slab).translateY(-0.4));
  const rock = mesh(wobble(new THREE.ConeGeometry(14, 9, 16, 6), 0.08, 3), toon("#6b4c8a"), true, false);
  rock.scale.set(1, 1, 0.66);
  rock.rotation.x = Math.PI;
  rock.position.y = -5.3;
  world.add(rock);
  const rock2 = mesh(wobble(new THREE.ConeGeometry(5, 5, 10, 4), 0.12, 8), toon("#5a3f78"), false, false);
  rock2.rotation.x = Math.PI;
  rock2.position.set(4, -10.5, 1.5);
  world.add(rock2);
  floorPlane(b, g1, -12.6, 13.6, -7.6, 8.6, 0, floorTexture(13, 8, "#e7d3a8", "#f6e8c6"));

  makeWall(b, g1, "x", -7.8, -13, 13, 0, 5.2, [
    { a0: -1.6, a1: 1.6, y0: 2.4, y1: 4.3 }, // pantry window
    { a0: 9.0, a1: 12.4, y0: 1.8, y1: 4.2 }, // game room window
  ], M.wall1);
  makeWall(b, g1, "z", -12.8, -8, 8, 0, 5.2, [{ a0: 2.6, a1: 6.4, y0: 1.7, y1: 4.0 }], M.wall1);
  boxAt(g1, 26, 0.25, 0.48, 0, 0, -7.8, M.dark, 0.04);
  boxAt(g1, 0.48, 0.25, 16, -12.8, 0, 0, M.dark, 0.04);
  partition(b, g1, "z", -3, -7.6, -2.4, 0);
  partition(b, g1, "z", 5, -7.6, -2.4, 0);
  partition(b, g1, "x", 0.8, -12.6, -9.8, 0);
}

export interface Floor1Props {
  tv: CanvasTex;
  coffee: { btn: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; cup: THREE.Mesh; nozzle: THREE.Vector3 };
  fridge: { door: THREE.Group; light: THREE.Mesh };
  arcade: CanvasTex;
  ping: { ball: THREE.Mesh };
  neon: CanvasTex & { draw: () => void };
  sign: CanvasTex & { draw: () => void };
}

export function buildFloor1Props(b: Build, g1: THREE.Group, tentacles: THREE.Group[], fonts: Fonts): Floor1Props {
  const { M } = b;
  const { toon, flat } = b.kit;
  const props = {} as Floor1Props;

  // --- Lounge ---
  {
    const rug = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#c3a6ff")), false, true);
    rug.rotation.x = -Math.PI / 2; rug.scale.set(4.2, 2.6, 1); rug.position.set(-8, 0.012, -4.8); g1.add(rug);
    const rug2 = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#a98ae6")), false, true);
    rug2.rotation.x = -Math.PI / 2; rug2.scale.set(3.6, 2.1, 1); rug2.position.set(-8, 0.015, -4.8); g1.add(rug2);
    // TV
    boxAt(g1, 4.6, 0.7, 0.8, -8, 0, -7.2, M.wood);
    for (const x of [-9.8, -6.2]) boxAt(g1, 0.12, 0.4, 0.05, x, 0.15, -6.78, M.trim, 0.02);
    boxAt(g1, 4.3, 2.5, 0.22, -8, 1.45, -7.45, M.dark, 0.08);
    const tv = canvasTex(320, 180);
    const scr = mesh(new THREE.PlaneGeometry(3.95, 2.18), noLine(flat("#ffffff", { map: tv.tex })), false, false);
    scr.position.set(-8, 2.7, -7.33); g1.add(scr);
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
    roomLabel(b, g1, "LOUNGE", -8, 0.2, -0.6, 1);
  }
  // --- Pantry ---
  {
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
    props.coffee = { btn, cup, nozzle: V(1.4, 1.75, -6.95) };
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
    // shelf with jars
    boxAt(g1, 2.4, 0.08, 0.35, -1.7, 3.0, -7.4, M.wood, 0.02);
    ([["#ff8fab", -2.5], ["#ffd23f", -1.9], ["#7bdff2", -1.3]] as const).forEach(([c, x]) => cyl(g1, 0.14, 0.14, 0.32, x, 3.08, -7.4, toon(c), 12));
    roomLabel(b, g1, "PANTRY", 0.6, 0.2, -1.9, 1);
  }
  // --- Game room ---
  {
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
    // neon sign
    const neon = canvasTex(256, 96) as Floor1Props["neon"];
    neon.draw = () => {
      const c = neon.ctx;
      c.fillStyle = "#1b1530"; c.fillRect(0, 0, 256, 96);
      c.font = `54px ${fonts.bungee}`; c.fillStyle = "#ff6fd8"; c.textAlign = "center"; c.fillText("PLAY", 128, 70);
      neon.tex.needsUpdate = true;
    };
    const ns = mesh(new THREE.PlaneGeometry(1.8, 0.68), noLine(flat("#ffffff", { map: neon.tex })), false, false);
    ns.position.set(8.0, 3.6, -7.55); g1.add(ns);
    props.neon = neon;
    roomLabel(b, g1, "GAME ROOM", 8.2, 0.2, -1.9, 1);
  }
  // --- Ruang rebahan ---
  {
    for (const [x, c] of [[-11.6, "#ffb3c6"], [-9.3, "#b0f2b4"]] as const) {
      boxAt(g1, 1.45, 0.3, 2.5, x, 0.02, 4.7, toon(c), 0.12);
      boxAt(g1, 1.0, 0.18, 0.5, x, 0.32, 3.75, M.white, 0.08);
      boxAt(g1, 1.35, 0.06, 1.3, x, 0.32, 5.25, toon(shade(c, -0.08)), 0.03);
    }
    cyl(g1, 0.35, 0.28, 0.6, -12.1, 0, 7.4, toon("#ff9f68"));
    const bush = mesh(wobble(new THREE.SphereGeometry(0.6, 16, 12), 0.15, 4), M.green); bush.position.set(-12.1, 1.05, 7.4); g1.add(bush);
    roomLabel(b, g1, "RUANG REBAHAN", -10.4, 0.2, 7.7, 1);
  }
  // --- Lobby ---
  {
    const rug = mesh(new THREE.CircleGeometry(2.6, 40), noLine(toon("#ffd9a8")), false, true);
    rug.rotation.x = -Math.PI / 2; rug.position.set(2.2, 0.012, 5.4); g1.add(rug);
    alienPlant(b, tentacles, g1, -1.6, 0, 6.4);
    // water cooler
    boxAt(g1, 0.7, 1.1, 0.7, 5.6, 0, 7.3, M.white, 0.08);
    const jug = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 18), thin(toon("#9fe6ff", { transparent: true, opacity: 0.7 })));
    jug.position.set(5.6, 1.45, 7.3); g1.add(jug);
    // welcome sign (left wall, near the front)
    const sign = canvasTex(320, 120) as Floor1Props["sign"];
    sign.draw = () => {
      const c = sign.ctx;
      c.fillStyle = "#ff6fd8"; c.fillRect(0, 0, 320, 120);
      c.fillStyle = "#1b1530"; c.font = `44px ${fonts.bungee}`; c.textAlign = "center"; c.fillText("AGENT HQ", 160, 62);
      c.font = `600 24px ${fonts.fredoka}`; c.fillText("lt.1 · area santai", 160, 100);
      sign.tex.needsUpdate = true;
    };
    const sg = mesh(new THREE.PlaneGeometry(2.8, 1.05), noLine(flat("#ffffff", { map: sign.tex })), false, false);
    sg.position.set(-12.55, 2.6, -0.6); sg.rotation.y = Math.PI / 2; g1.add(sg);
    props.sign = sign;
    boxAt(g1, 0.08, 1.2, 2.95, -12.6, 2.0, -0.6, M.dark, 0.03);
    roomLabel(b, g1, "LOBBY", 2.4, 0.2, 7.6, 1);
  }
  return props;
}
