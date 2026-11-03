// Alien sky: gradient background, stars, ringed planet, moons, floating rocks (port from the prototype).

import * as THREE from "three";
import { canvasTex, mesh, noLine, wobble, type Kit } from "./kit";

export function makeSkyTexture(): THREE.CanvasTexture {
  const { ctx, tex } = canvasTex(16, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, "#1c0b3d");
  g.addColorStop(0.45, "#4a1a7a");
  g.addColorStop(0.75, "#c2418e");
  g.addColorStop(1, "#ff9a6b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  return tex;
}

/**
 * Builds the sky decor and returns the floating rocks to animate. Solid bodies (ringed planet incl. its ring,
 * moons, floating rocks) carry `userData.obstacleRadius` so sky events can steer clear of them.
 */
export function buildSky(kit: Kit, scene: THREE.Scene): THREE.Mesh[] {
  const { toon } = kit;
  const skyAnim: THREE.Mesh[] = [];
  const starsGeo = new THREE.BufferGeometry();
  const pts: number[] = [];
  for (let i = 0; i < 800; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(130 + Math.random() * 40);
    if (v.y < -25) v.y *= -0.4;
    pts.push(v.x, v.y, v.z);
  }
  starsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: "#fff6e3", size: 0.55, sizeAttenuation: true })));
  const ringed = new THREE.Group(); ringed.position.set(-40, 14, -56); scene.add(ringed);
  ringed.add(mesh(new THREE.SphereGeometry(9, 40, 28), toon("#ff9ecf"), false, false));
  ringed.add(mesh(new THREE.SphereGeometry(9.02, 40, 6, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.12), noLine(toon("#ff6fb5")), false, false));
  const ring = mesh(new THREE.RingGeometry(11.5, 16, 64), noLine(kit.flat("#ffd9a8", { side: THREE.DoubleSide, transparent: true, opacity: 0.85 })), false, false);
  ring.rotation.x = Math.PI / 2.4; ringed.add(ring); ringed.rotation.z = 0.3;
  ringed.userData.obstacleRadius = 16.5; // outer ring radius 16
  const moonA = mesh(new THREE.SphereGeometry(3, 28, 20), toon("#ffe08a"), false, false); moonA.position.set(36, 26, -46); moonA.userData.obstacleRadius = 3; scene.add(moonA);
  const moonB = mesh(new THREE.SphereGeometry(1.6, 24, 16), toon("#9fe6ff"), false, false); moonB.position.set(43, 18, -36); moonB.userData.obstacleRadius = 1.6; scene.add(moonB);
  for (let i = 0; i < 9; i++) {
    const r = 0.6 + Math.random() * 1.2;
    const m = mesh(wobble(new THREE.IcosahedronGeometry(r, 2), 0.14, i * 3.3), toon(i % 2 ? "#6b4c8a" : "#7d5a9e"), false, false);
    const ang = (i / 9) * Math.PI * 2 + 0.4, dist = 22 + Math.random() * 7;
    m.position.set(Math.cos(ang) * dist, -3 + Math.random() * 9, Math.sin(ang) * dist * 0.8);
    m.userData.base = m.position.y; m.userData.ph = Math.random() * 6;
    m.userData.obstacleRadius = r * 1.25 + 0.6; // wobble bumps, plus the +-0.6 bob
    m.userData.smallRock = true; // avoided, but may pass in front of an event (natural layering)
    scene.add(m); skyAnim.push(m);
  }
  return skyAnim;
}
