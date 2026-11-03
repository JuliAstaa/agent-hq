// Original cartoon agent characters (port of buildAvatar in references/agent-hq.html).
// Shape, color, accessory and eye count are derived from a hash of the agent id.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { ACCESSORIES, INK, SHAPES } from "../constants";
import { mesh, noLine, pick, rbox, shade, wobble, type Kit, type Materials } from "../scene/kit";
import { BODY_COLORS, hashStr } from "@/lib/palette";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export interface Eye {
  g: THREE.Group;
  piv: THREE.Group;
  lid: THREE.Mesh;
  r: number;
}

export interface AvatarProps {
  phone: THREE.Group;
  phoneScreen: BasicMesh;
  book: THREE.Group;
  cards: THREE.Group;
  mug: THREE.Group;
  paddle: THREE.Group;
  /** Task card carried from the task board to the desk (deviation 14), in the left hand. */
  taskCard: THREE.Group;
}

export interface Avatar {
  root: THREE.Group;
  poseG: THREE.Group;
  bob: THREE.Group;
  eyes: Eye[];
  mouth: THREE.Mesh;
  arms: THREE.Group[];
  legs: THREE.Group[];
  bulbMat: THREE.MeshBasicMaterial;
  label: CSS2DObject;
  el: HTMLDivElement;
  top: number;
  cy: number;
  front: number;
  depth: number;
  color: string;
  P: AvatarProps;
  blinkT: number;
  blinking: number;
  lookPh: number;
  smokeT: number;
  /** Spawn pop-in progress 0..1; undefined once done. */
  spawn?: number;
  /** Floor number currently shown in the bubble badge. */
  badgeFloor?: number;
}

export function buildAvatar(kit: Kit, M: Materials, id: string, onClick: () => void): Avatar {
  const { toon, flat } = kit;
  const h = hashStr(id);
  const shape = SHAPES[h % SHAPES.length];
  const color = BODY_COLORS[(h >>> 3) % BODY_COLORS.length];
  const acc = ACCESSORIES[(h >>> 7) % ACCESSORIES.length];
  const eyeCount = shape === "tall" ? 2 : 1 + ((h >>> 11) % 2) + ((h >>> 13) % 4 === 0 ? 1 : 0);
  const bodyMat = toon(color), darkBody = toon(shade(color, -0.12));
  const root = new THREE.Group(), poseG = new THREE.Group(), bob = new THREE.Group();
  root.add(poseG);
  poseG.add(bob);
  let cy: number, top: number, front: number, half: number, depth: number;
  if (shape === "blob") {
    const b = mesh(wobble(new THREE.SphereGeometry(0.62, 32, 24), 0.05, h % 100), bodyMat);
    b.scale.set(1, 1.1, 0.95);
    cy = 1.31; b.position.y = cy; bob.add(b);
    top = cy + 0.68; front = 0.57; half = 0.6; depth = 0.58;
  } else if (shape === "bot") {
    const b = mesh(rbox(1.05, 1.15, 0.9, 0.26), bodyMat);
    cy = 1.24; b.position.y = cy; bob.add(b);
    const panel = mesh(rbox(0.7, 0.42, 0.06, 0.08), M.white); panel.position.set(0, cy + 0.1, 0.45); bob.add(panel);
    top = cy + 0.58; front = 0.5; half = 0.53; depth = 0.46;
  } else {
    const b = mesh(new THREE.CapsuleGeometry(0.44, 0.75, 8, 20), bodyMat);
    cy = 1.42; b.position.y = cy; bob.add(b);
    top = cy + 0.82; front = 0.44; half = 0.44; depth = 0.44;
  }
  if (shape !== "bot") {
    const spot = mesh(new THREE.CircleGeometry(0.2, 18), noLine(darkBody), false, false);
    spot.position.set(0, cy - 0.28, front - 0.02); bob.add(spot);
  }
  // legs
  const legs: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const p = new THREE.Group(); p.position.set(s * 0.22, 0.72, 0.02);
    const l = mesh(new THREE.CapsuleGeometry(0.1, 0.36, 4, 10), bodyMat); l.position.y = -0.3; p.add(l);
    const foot = mesh(new THREE.SphereGeometry(0.14, 12, 10), darkBody); foot.scale.set(1, 0.6, 1.4); foot.position.set(0, -0.62, 0.06); p.add(foot);
    bob.add(p); legs.push(p);
  }
  // eyes
  const eyes: Eye[] = [];
  const eyeY = shape === "tall" ? top + 0.28 : cy + 0.2;
  const er = eyeCount === 1 ? 0.27 : eyeCount === 2 ? 0.19 : 0.15;
  const offs = eyeCount === 1 ? [0] : eyeCount === 2 ? [-0.22, 0.22] : [-0.3, 0, 0.3];
  offs.forEach((ox, i) => {
    const eg = new THREE.Group();
    eg.position.set(ox, eyeY + (eyeCount === 3 && i === 1 ? 0.12 : 0), shape === "tall" ? 0.05 : front - er * 0.45);
    if (shape === "tall") {
      const stalk = mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.42, 8), bodyMat);
      stalk.position.set(ox * 0.6, top - 0.05, 0.02); stalk.rotation.z = -ox * 0.9; bob.add(stalk);
      eg.position.x = ox * 1.15;
    }
    eg.add(mesh(new THREE.SphereGeometry(er, 22, 16), toon("#ffffff")));
    const piv = new THREE.Group(); eg.add(piv);
    const pupil = mesh(new THREE.SphereGeometry(er * 0.42, 14, 10), noLine(flat(INK)), false, false);
    pupil.position.z = er * 0.72; pupil.scale.z = 0.5; piv.add(pupil);
    const shine = mesh(new THREE.SphereGeometry(er * 0.12, 8, 6), noLine(flat("#ffffff")), false, false);
    shine.position.set(er * 0.14, er * 0.16, er * 0.95); piv.add(shine);
    const lid = mesh(new THREE.SphereGeometry(er * 1.04, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), toon(shade(color, -0.08)));
    lid.rotation.x = -Math.PI / 2 + 0.5; eg.add(lid);
    bob.add(eg); eyes.push({ g: eg, piv, lid, r: er });
  });
  const mouth = mesh(new THREE.TorusGeometry(0.12, 0.028, 8, 18, Math.PI), noLine(flat(INK)), false, false);
  mouth.position.set(0, shape === "tall" ? cy + 0.25 : cy - 0.12, shape === "bot" ? 0.475 : front + 0.01);
  mouth.rotation.z = Math.PI; mouth.userData.y = mouth.position.y; bob.add(mouth);
  // arms
  const arms: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const p = new THREE.Group(); p.position.set(s * (half - 0.02), cy - 0.05, 0.05);
    const a = mesh(new THREE.CapsuleGeometry(0.085, 0.42, 4, 10), bodyMat); a.position.y = -0.28; p.add(a);
    const hand = mesh(new THREE.SphereGeometry(0.11, 12, 10), darkBody); hand.position.y = -0.55; p.add(hand);
    p.rotation.x = -1.1; p.rotation.z = s * 0.15; bob.add(p); arms.push(p);
  }
  // antenna
  const ant = new THREE.Group(); ant.position.set(shape === "tall" ? 0 : 0.12, top - 0.04, 0); ant.rotation.z = -0.2; bob.add(ant);
  ant.add(mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.38, 6), M.dark).translateY(0.19));
  const bulbMat = noLine(flat("#a6e22e"));
  const bulb = mesh(new THREE.SphereGeometry(0.09, 14, 10), bulbMat, false, false); bulb.position.y = 0.42; ant.add(bulb);
  const bulbRing = mesh(new THREE.SphereGeometry(0.1, 14, 10), noLine(new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide })), false, false);
  bulbRing.scale.setScalar(1.25); bulb.add(bulbRing);
  if (acc === "hardhat") {
    const hat = new THREE.Group(); hat.position.y = top - 0.12; bob.add(hat);
    hat.add(mesh(new THREE.SphereGeometry(0.42, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.yellow));
    hat.add(mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.05, 22), M.yellow).translateY(0.02));
    ant.position.y = top + 0.25;
  } else if (acc === "headphones") {
    const band = mesh(new THREE.TorusGeometry(half + 0.04, 0.05, 8, 24, Math.PI), M.dark);
    band.position.y = cy + 0.05 + (shape === "tall" ? 0.25 : 0); bob.add(band);
    for (const s of [-1, 1]) {
      const cup = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 16), toon("#ff6fd8"));
      cup.rotation.z = Math.PI / 2; cup.position.set(s * (half + 0.04), band.position.y, 0); bob.add(cup);
    }
  } else if (acc === "horns") {
    for (const s of [-1, 1]) {
      const hn = mesh(new THREE.ConeGeometry(0.1, 0.32, 10), M.white);
      hn.position.set(s * 0.3, top - 0.08, -0.05); hn.rotation.z = -s * 0.45; bob.add(hn);
    }
  } else if (acc === "glasses" && shape !== "tall") {
    offs.forEach((ox) => {
      const gl = mesh(new THREE.TorusGeometry(er * 1.12, 0.025, 6, 20), noLine(flat(INK)), false, false);
      gl.position.set(ox, eyeY + (eyeCount === 3 && ox === 0 ? 0.12 : 0), front + er * 0.5); bob.add(gl);
    });
  }
  // props
  const phone = new THREE.Group(); phone.position.set(0, cy - 0.05, front + 0.3); phone.rotation.x = 0.5; bob.add(phone);
  phone.add(mesh(rbox(0.22, 0.38, 0.04, 0.03), M.dark));
  const phoneScreen = mesh(new THREE.PlaneGeometry(0.17, 0.31), noLine(flat("#7bdff2")), false, false) as BasicMesh;
  phoneScreen.position.z = -0.022; phoneScreen.rotation.y = Math.PI; phone.add(phoneScreen);
  const book = new THREE.Group(); book.position.set(0, cy - 0.12, front + 0.24); book.rotation.x = 0.35; bob.add(book);
  for (const s of [-1, 1]) {
    const cv = mesh(rbox(0.26, 0.36, 0.03, 0.01), toon(pick(["#ff6fd8", "#59c3ff", "#ffd23f"])));
    cv.position.x = s * 0.12; cv.rotation.y = -s * 0.4; book.add(cv);
    const pg = mesh(new THREE.PlaneGeometry(0.22, 0.32), noLine(flat("#fff6e3", { side: THREE.DoubleSide })), false, false);
    pg.position.set(s * 0.12, 0, -0.02); pg.rotation.y = -s * 0.4; book.add(pg);
  }
  const cards = new THREE.Group(); cards.position.set(0, cy - 0.05, front + 0.22); bob.add(cards);
  for (let i = 0; i < 4; i++) {
    const c = mesh(rbox(0.13, 0.18, 0.012, 0.004), toon(i % 2 ? "#ff4f5e" : "#fff6e3"));
    c.rotation.z = (i - 1.5) * 0.25; c.position.x = (i - 1.5) * 0.04; c.position.z = i * 0.004; cards.add(c);
  }
  const mug = new THREE.Group(); mug.position.set(0, -0.62, 0.12); arms[1].add(mug);
  mug.add(mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.18, 12), M.white));
  const hdl = mesh(new THREE.TorusGeometry(0.06, 0.018, 6, 12), M.white); hdl.position.x = 0.11; mug.add(hdl);
  const paddle = new THREE.Group(); paddle.position.set(0, -0.68, 0); arms[1].add(paddle);
  paddle.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.18, 8), M.woodD));
  const blade = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 18), M.red); blade.rotation.x = Math.PI / 2; blade.position.y = -0.2; paddle.add(blade);
  const taskCard = new THREE.Group(); taskCard.position.set(0, -0.66, 0.1); arms[0].add(taskCard);
  const tcPaper = mesh(rbox(0.3, 0.34, 0.02, 0.01), M.white); tcPaper.rotation.x = -0.25; taskCard.add(tcPaper);
  const tcStripe = mesh(new THREE.PlaneGeometry(0.26, 0.07), noLine(toon(color)), false, false); tcStripe.position.set(0, 0.11, 0.012); tcPaper.add(tcStripe);
  const P: AvatarProps = { phone, phoneScreen, book, cards, mug, paddle, taskCard };
  for (const o of [phone, book, cards, mug, paddle, taskCard]) o.visible = false;
  // bubble (static markup; agent strings are set with textContent)
  const el = document.createElement("div");
  el.className = "bubble";
  el.innerHTML = '<span class="ic"></span><span class="fl">Lt.1</span><span class="tx"><span class="nm"></span> <span class="tt"></span></span>';
  el.style.pointerEvents = "auto";
  el.style.cursor = "pointer";
  el.addEventListener("click", onClick);
  const label = new CSS2DObject(el);
  label.position.set(0, top + 0.95, 0);
  root.add(label);
  root.traverse((o) => {
    o.userData.agentId = id;
  });
  return {
    root, poseG, bob, eyes, mouth, arms, legs, bulbMat, label, el, top, cy, front, depth, color, P,
    blinkT: 1 + Math.random() * 3, blinking: 0, lookPh: Math.random() * 10, smokeT: 0,
  };
}
