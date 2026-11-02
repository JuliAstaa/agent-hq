import * as THREE from "three";
import { cyl, mesh, noLine, V } from "../../scene/kit";
import type { Build } from "../structure";

/** Potted alien plant with swaying tentacles. Pivots are pushed to `tentacles` for animation. */
export function alienPlant(b: Build, tentacles: THREE.Group[], parent: THREE.Object3D, x: number, y: number, z: number, scale = 1) {
  const { toon } = b.kit;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  parent.add(g);
  cyl(g, 0.55, 0.4, 0.8, 0, 0, 0, toon("#ff9f68"), 16);
  cyl(g, 0.5, 0.5, 0.06, 0, 0.78, 0, noLine(toon("#4a2f22")), 16);
  for (let i = 0; i < 5; i++) {
    const pivot = new THREE.Group();
    pivot.position.y = 0.8;
    pivot.rotation.y = (i / 5) * Math.PI * 2;
    g.add(pivot);
    const h = 1.4 + Math.random() * 0.9;
    const curve = new THREE.CatmullRomCurve3([V(0, 0, 0), V(0.15, h * 0.4, 0.1), V(0.45, h * 0.75, 0), V(0.75, h, 0.15)]);
    pivot.add(mesh(new THREE.TubeGeometry(curve, 20, 0.09, 8, false), toon(i % 2 ? "#c86bfa" : "#a24de0")));
    const tip = mesh(new THREE.SphereGeometry(0.16, 14, 10), b.M.yellow);
    tip.position.copy(curve.getPoint(1));
    pivot.add(tip);
    pivot.userData.ph = Math.random() * 6;
    tentacles.push(pivot);
  }
}
