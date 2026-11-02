// Floor 3 "Security Ops": Red Team lab, VA report room, SOC Blue Team, lift F2<->F3, team stations.
// Ported 1:1 from references/agent-hq.html.

import * as THREE from "three";
import { F2, F3 } from "../constants";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, thin, type CanvasTex } from "../scene/kit";
import { STATION_LAYOUT, stationPlace, type StationPlace } from "../nav/places";
import { DEPTS, type Dept } from "@/lib/teams";
import { alienPlant } from "./props/alienPlant";
import { makeWall, partition, roomLabel, type Build } from "./structure";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type ToonMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;

export interface Station {
  dept: Dept;
  group: THREE.Group;
  chair: THREE.Group;
  ring: BasicMesh;
  glow: BasicMesh;
  strip: BasicMesh;
  cv: CanvasTex;
  texs: THREE.Texture[];
  place: StationPlace;
}

export interface Sec {
  redWall: CanvasTex;
  holo: { model: THREE.Group; scan: THREE.Mesh; disc: BasicMesh };
  sign: CanvasTex & { draw: () => void };
  board: CanvasTex;
  printer: { paper: THREE.Mesh; stack: THREE.Mesh; n: number };
  soc: CanvasTex;
  siren: { dome: ToonMesh; beams: THREE.Group; light: THREE.PointLight };
  pad: BasicMesh;
  stations: Station[];
}

export function buildFloor3(b: Build, g2: THREE.Group, g3: THREE.Group, tentacles: THREE.Group[], fonts: Fonts): Sec {
  const { M } = b;
  const { toon, flat } = b.kit;
  const SEC = {} as Sec;

  // slab with the lift hole
  for (const [x0, x1, z0, z1] of [[-13, 5.8, -8, 8.4], [7.8, 13, -8, 8.4], [5.8, 7.8, -8, 3.8], [5.8, 7.8, 5.8, 8.4]]) {
    boxAt(g3, x1 - x0, 0.4, z1 - z0, (x0 + x1) / 2, F3 - 0.4, (z0 + z1) / 2, M.slab, 0.04, false);
  }
  const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
  const sh = new THREE.Shape([V2(-12.6, 7.6), V2(13, 7.6), V2(13, -8.4), V2(-12.6, -8.4)]);
  sh.holes.push(new THREE.Path([V2(5.8, -3.8), V2(5.8, -5.8), V2(7.8, -5.8), V2(7.8, -3.8)]));
  const tile = canvasTex(128, 128);
  {
    const c = tile.ctx;
    c.fillStyle = "#2f2858"; c.fillRect(0, 0, 128, 128);
    c.fillStyle = "#383066"; c.fillRect(0, 0, 64, 64); c.fillRect(64, 64, 64, 64);
    c.strokeStyle = "rgba(160,140,255,.18)"; c.lineWidth = 2; c.strokeRect(1, 1, 126, 126);
  }
  tile.tex.wrapS = tile.tex.wrapT = THREE.RepeatWrapping;
  tile.tex.repeat.set(0.25, 0.25);
  const fl = mesh(new THREE.ShapeGeometry(sh), noLine(toon("#ffffff", { map: tile.tex })), false, true);
  fl.rotation.x = -Math.PI / 2; fl.position.y = F3 + 0.006; g3.add(fl);
  // walls
  makeWall(b, g3, "x", -7.8, -13, -4, F3, 4.4, [], M.redWall);
  makeWall(b, g3, "x", -7.8, -4, 4, F3, 4.4, [], M.repWall);
  makeWall(b, g3, "x", -7.8, 4, 13, F3, 4.4, [], M.socWall);
  makeWall(b, g3, "z", -12.8, -8, 8.4, F3, 4.4, [{ a0: 3, a1: 6.5, y0: F3 + 1.3, y1: F3 + 3.3 }], M.redWall);
  boxAt(g3, 26.4, 0.18, 0.56, 0, F3 + 4.4, -7.8, M.trim, 0.04);
  boxAt(g3, 0.56, 0.18, 16.4, -12.8, F3 + 4.4, 0.2, M.trim, 0.04);
  boxAt(g3, 26, 0.25, 0.48, 0, F3, -7.8, M.dark, 0.04);
  boxAt(g3, 0.48, 0.25, 16, -12.8, F3, 0.2, M.dark, 0.04);
  partition(b, g3, "z", -4, -7.6, -2.2, F3);
  partition(b, g3, "z", 4, -7.6, -2.2, F3);
  const rug = (x0: number, x1: number, z0: number, z1: number, c: string) => {
    const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), noLine(toon(c)), false, true);
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, F3 + 0.012, (z0 + z1) / 2); g3.add(m);
  };
  rug(-12.4, -4.3, -7.4, 1.6, "#4a1f33"); rug(-3.7, 3.7, -7.4, 0.9, "#d9c39a"); rug(4.3, 12.6, -7.4, 1.9, "#16284a");

  // --- Red Team: attack-surface wall + hologram target ---
  boxAt(g3, 6.3, 2.25, 0.16, -8.6, F3 + 1.95, -7.5, M.dark, 0.06);
  SEC.redWall = canvasTex(768, 256);
  const rw = mesh(new THREE.PlaneGeometry(6.0, 2.0), noLine(flat("#ffffff", { map: SEC.redWall.tex })), false, false);
  rw.position.set(-8.6, F3 + 3.07, -7.41); g3.add(rw);
  const holo = new THREE.Group(); holo.position.set(-8.8, F3, 4.4); g3.add(holo);
  cyl(holo, 0.95, 1.05, 0.85, 0, 0, 0, M.dark, 24);
  const disc = mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.04, 32), noLine(flat("#59c3ff")), false, false) as BasicMesh;
  disc.position.y = 0.88; holo.add(disc);
  const model = new THREE.Group(); model.position.y = 1.0; holo.add(model);
  const hmat = noLine(flat("#7fe3ff", { transparent: true, opacity: 0.35, depthWrite: false }));
  const edgeMat = new THREE.LineBasicMaterial({ color: "#bff3ff" });
  for (const [w, h, d, x, z] of [[0.9, 0.55, 0.6, 0, 0], [0.32, 1.05, 0.32, 0.42, -0.12], [0.45, 0.3, 0.4, -0.45, 0.2]]) {
    const g = new THREE.BoxGeometry(w, h, d);
    const bx = new THREE.Mesh(g, hmat); bx.position.set(x, h / 2, z); model.add(bx);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat); e.position.copy(bx.position); model.add(e);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.35, 4), hmat); roof.position.set(0, 0.72, 0); roof.rotation.y = Math.PI / 4; model.add(roof);
  const scan = mesh(new THREE.TorusGeometry(0.72, 0.025, 6, 40), noLine(flat("#ff4f5e")), false, false);
  scan.rotation.x = Math.PI / 2; scan.position.y = 1.2; holo.add(scan);
  SEC.holo = { model, scan, disc };
  const sign = canvasTex(360, 110) as Sec["sign"];
  sign.draw = () => {
    const c = sign.ctx;
    c.fillStyle = "#1b1530"; c.fillRect(0, 0, 360, 110);
    c.font = `40px ${fonts.bungee}`; c.textAlign = "center";
    c.fillStyle = "#ff4f5e"; c.fillText("SECURITY", 180, 50);
    c.fillStyle = "#59c3ff"; c.fillText("OPS", 180, 96);
    sign.tex.needsUpdate = true;
  };
  SEC.sign = sign;
  const sg = mesh(new THREE.PlaneGeometry(2.6, 0.8), noLine(flat("#ffffff", { map: sign.tex })), false, false);
  sg.position.set(-12.55, F3 + 2.7, 0.4); sg.rotation.y = Math.PI / 2; g3.add(sg);
  boxAt(g3, 0.08, 0.92, 2.72, -12.6, F3 + 2.24, 0.4, M.dark, 0.03);

  // --- VA report room: CVSS board, printer, filing cabinet ---
  boxAt(g3, 5.2, 2.25, 0.16, 0, F3 + 1.85, -7.5, M.wood, 0.06);
  SEC.board = canvasTex(640, 270);
  const bd = mesh(new THREE.PlaneGeometry(4.95, 2.05), noLine(flat("#ffffff", { map: SEC.board.tex })), false, false);
  bd.position.set(0, F3 + 2.97, -7.41); g3.add(bd);
  const pr = new THREE.Group(); pr.position.set(2.4, F3, -1.4); g3.add(pr);
  boxAt(pr, 1.1, 0.8, 0.8, 0, 0, 0, M.white, 0.06);
  boxAt(pr, 0.95, 0.42, 0.7, 0, 0.8, 0, toon("#cfd3e6"), 0.08);
  boxAt(pr, 0.6, 0.05, 0.35, 0, 0.88, 0.4, M.dark, 0.02);
  const paper = mesh(new THREE.PlaneGeometry(0.45, 0.58), noLine(flat("#ffffff", { side: THREE.DoubleSide })), false, false);
  paper.rotation.x = -Math.PI / 2; paper.position.set(0, 0.95, 0.1); pr.add(paper);
  const stack = boxAt(pr, 0.47, 0.06, 0.6, 0, 0.8, 0.62, M.white, 0.01); stack.scale.y = 0.3;
  SEC.printer = { paper, stack, n: 0 };
  boxAt(g3, 0.75, 1.6, 0.7, 3.35, F3, -7.1, toon("#8fa3b8"), 0.05);
  for (let i = 0; i < 3; i++) boxAt(g3, 0.3, 0.05, 0.03, 3.35, F3 + 0.35 + i * 0.5, -6.74, M.dark, 0.01, false);

  // --- SOC Blue Team: video wall + siren ---
  boxAt(g3, 7.9, 2.8, 0.16, 8.3, F3 + 1.45, -7.5, M.dark, 0.06);
  SEC.soc = canvasTex(1024, 336);
  const sw = mesh(new THREE.PlaneGeometry(7.6, 2.5), noLine(flat("#ffffff", { map: SEC.soc.tex })), false, false);
  sw.position.set(8.3, F3 + 2.85, -7.41); g3.add(sw);
  const siren = new THREE.Group(); siren.position.set(12.25, F3 + 3.95, -7.3); g3.add(siren);
  boxAt(siren, 0.5, 0.12, 0.5, 0, -0.12, 0, M.dark, 0.03);
  const dome = mesh(new THREE.SphereGeometry(0.24, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon("#7a2030")) as ToonMesh;
  siren.add(dome);
  const beams = new THREE.Group(); beams.position.y = 0.1; siren.add(beams);
  const beamGeo = new THREE.ConeGeometry(0.7, 4.5, 20, 1, true); beamGeo.translate(0, -2.25, 0); beamGeo.rotateX(-Math.PI / 2);
  const beamMat = noLine(flat("#ff2a3a", { transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  for (const r of [0, Math.PI]) {
    const bm = new THREE.Mesh(beamGeo, beamMat); bm.rotation.y = r; beams.add(bm);
  }
  beams.visible = false;
  const alarm = new THREE.PointLight("#ff2a3a", 0, 14, 0); alarm.position.set(8.3, F3 + 3.4, -3); g3.add(alarm);
  SEC.siren = { dome, beams, light: alarm };

  // --- lift Lt.2 <-> Lt.3 ---
  const LX = 6.8, LZ = 4.8;
  const glassM = thin(toon("#bfe9ff", { transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }), 0.7);
  const gapC = Math.atan2(5.4 - LX, 4.0 - LZ);
  const tubeGeo = (h: number) => new THREE.CylinderGeometry(0.95, 0.95, h, 32, 1, true, gapC + 0.7, Math.PI * 2 - 1.4);
  const t2 = mesh(tubeGeo(F3 - F2), glassM, false, false); t2.position.set(LX, F2 + (F3 - F2) / 2, LZ); g2.add(t2);
  const t3 = mesh(tubeGeo(2.8), glassM, false, false); t3.position.set(LX, F3 + 1.4, LZ); g3.add(t3);
  cyl(g2, 1.12, 1.12, 0.1, LX, F2, LZ, M.dark, 32);
  const pad = mesh(new THREE.CircleGeometry(0.9, 32), noLine(flat("#ff6fd8")), false, false) as BasicMesh;
  pad.rotation.x = -Math.PI / 2; pad.position.set(LX, F2 + 0.11, LZ); g2.add(pad);
  cyl(g3, 1.12, 1.12, 0.14, LX, F3 + 2.8, LZ, M.dark, 32);
  for (const [g, y] of [[g2, F2 + 0.15], [g2, F3 - 0.5], [g3, F3 + 0.05], [g3, F3 + 2.7]] as const) {
    const r = mesh(new THREE.TorusGeometry(0.97, 0.05, 8, 40), noLine(flat("#ff6fd8")), false, false);
    r.rotation.x = Math.PI / 2; r.position.set(LX, y, LZ); g.add(r);
  }
  SEC.pad = pad;
  roomLabel(b, g2, "LIFT KE LT.3", LX, F2 + 0.2, LZ + 1.6, 2);
  roomLabel(b, g3, "LIFT", LX, F3 + 0.2, LZ + 1.6, 3);
  alienPlant(b, tentacles, g3, -12.0, F3, 7.3, 0.8);
  alienPlant(b, tentacles, g3, 12.2, F3, 7.3, 0.8);
  roomLabel(b, g3, "RED TEAM LAB", -8.6, F3 + 0.2, 6.6, 3);
  roomLabel(b, g3, "RUANG LAPORAN VA", 0, F3 + 0.2, 1.4, 3);
  roomLabel(b, g3, "SOC · BLUE TEAM", 10.6, F3 + 0.2, 2.6, 3);

  SEC.stations = STATION_LAYOUT.map((_, i) => buildStation(b, g3, i));
  return SEC;
}

/** Team workstation, facing the back wall so the camera sees the agent over the shoulder. */
function buildStation(b: Build, g3: THREE.Group, index: number): Station {
  const { M } = b;
  const { toon, flat } = b.kit;
  const [dept, x, z] = STATION_LAYOUT[index];
  const g = new THREE.Group(); g.position.set(x, F3, z); g.rotation.y = Math.PI; g3.add(g);
  const topC = { red: "#a8394f", report: "#c98a4b", blue: "#3a6fb8" }[dept];
  g.add(mesh(rbox(2.6, 0.14, 1.3, 0.06), toon(topC)).translateY(1.02));
  for (const sx of [-1.15, 1.15]) {
    const leg = mesh(rbox(0.14, 0.95, 1.1, 0.04), M.dark); leg.position.set(sx, 0.48, 0); g.add(leg);
  }
  const strip = mesh(rbox(2.2, 0.07, 0.05, 0.02), flat("#3a3360")) as BasicMesh;
  strip.position.set(0, 0.86, -0.62); g.add(strip);
  const cv = canvasTex(512, 160);
  const tA = cv.tex; tA.repeat.set(0.5, 1); tA.offset.set(0, 0);
  const tB = cv.tex.clone(); tB.repeat.set(0.5, 1); tB.offset.set(0.5, 0); tB.needsUpdate = true;
  ([[-0.5, -0.25, tB], [0.5, 0.25, tA]] as const).forEach(([mx, ry, tex]) => {
    const mon = new THREE.Group(); mon.position.set(mx, 1.1, 0.25); mon.rotation.y = Math.PI + ry; g.add(mon);
    mon.add(mesh(new THREE.CylinderGeometry(0.05, 0.16, 0.26, 10), M.dark).translateY(0.12));
    mon.add(mesh(rbox(0.98, 0.64, 0.08, 0.05), M.dark).translateY(0.6));
    const sc = mesh(new THREE.PlaneGeometry(0.88, 0.54), noLine(flat("#ffffff", { map: tex })), false, false);
    sc.position.set(0, 0.6, 0.045); mon.add(sc);
  });
  const kb = mesh(rbox(0.75, 0.05, 0.26, 0.02), toon("#e9e3f5")); kb.position.set(0, 1.12, -0.32); g.add(kb);
  if (dept === "report") for (let i = 0; i < 3; i++) boxAt(g, 0.42, 0.05 + i * 0.03, 0.55, -1.0, 1.09 + i * 0.07, -0.1 + i * 0.02, M.white, 0.01);
  if (dept === "red") for (const cx of [1.0, 1.15]) cyl(g, 0.06, 0.06, 0.2, cx, 1.09, -0.2, toon("#ff4f5e"), 10);
  if (dept === "blue") cyl(g, 0.09, 0.08, 0.18, 1.05, 1.09, -0.2, toon("#9ad0ff"), 12);
  const chair = new THREE.Group(); chair.position.set(0, 0, -1.05); g.add(chair);
  chair.add(mesh(new THREE.CylinderGeometry(0.58, 0.5, 0.14, 24), toon("#4a3f80")).translateY(0.58));
  const ring = mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 28), noLine(flat("#3a3360")), false, false) as BasicMesh;
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.36; chair.add(ring);
  const glow = mesh(new THREE.CircleGeometry(0.6, 24), noLine(flat(DEPTS[dept].color, { transparent: true, opacity: 0 })), false, false) as BasicMesh;
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012; chair.add(glow);
  return { dept, group: g, chair, ring, glow, strip, cv, texs: [tA, tB], place: stationPlace(index) };
}
