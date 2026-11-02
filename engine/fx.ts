// Smoke puffs and confetti (port of spawnSmoke/spawnConfetti/updateFx in references/agent-hq.html).

import * as THREE from "three";
import { mesh, noLine, V, type Kit } from "./scene/kit";

interface Particle {
  m: THREE.Mesh<THREE.BufferGeometry, THREE.Material & { opacity: number }>;
  life: number;
  max: number;
  vel: THREE.Vector3;
  spin?: THREE.Vector3;
  kind: "smoke" | "confetti";
}

export interface Fx {
  smoke: (pos: THREE.Vector3, color?: string, size?: number, rise?: number) => void;
  confetti: (pos: THREE.Vector3) => void;
  update: (dt: number) => void;
}

export function createFx(kit: Kit, world: THREE.Group): Fx {
  const fx: Particle[] = [];
  return {
    smoke(pos, color = "#cfc8e0", size = 1, rise = 0.9) {
      const m = mesh(new THREE.SphereGeometry((0.16 + Math.random() * 0.1) * size, 12, 10), kit.toon(color, { transparent: true, opacity: 0.9 }), false, false) as Particle["m"];
      m.position.copy(pos).add(V((Math.random() - 0.5) * 0.3 * size, 0, (Math.random() - 0.5) * 0.2 * size));
      world.add(m);
      fx.push({ m, life: 1.4, max: 1.4, vel: V((Math.random() - 0.5) * 0.3, rise, 0), kind: "smoke" });
    },
    confetti(pos) {
      const cols = ["#ffd23f", "#ff6fd8", "#59c3ff", "#a6e22e", "#ff9f68"];
      for (let i = 0; i < 34; i++) {
        const m = mesh(new THREE.PlaneGeometry(0.12, 0.07), noLine(kit.flat(cols[i % cols.length], { side: THREE.DoubleSide, transparent: true })), false, false) as Particle["m"];
        m.position.copy(pos);
        world.add(m);
        const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2.2;
        fx.push({ m, life: 1.8, max: 1.8, vel: V(Math.cos(a) * sp * 0.6, 3 + Math.random() * 2.5, Math.sin(a) * sp * 0.6), spin: V(Math.random() * 9, Math.random() * 9, Math.random() * 9), kind: "confetti" });
      }
    },
    update(dt) {
      for (let i = fx.length - 1; i >= 0; i--) {
        const f = fx[i];
        f.life -= dt;
        if (f.life <= 0) {
          world.remove(f.m);
          f.m.geometry.dispose();
          f.m.material.dispose();
          fx.splice(i, 1);
          continue;
        }
        const k = f.life / f.max;
        if (f.kind === "smoke") {
          f.m.position.addScaledVector(f.vel, dt);
          f.m.scale.setScalar(1 + (1 - k) * 1.6);
          f.m.material.opacity = 0.9 * k;
        } else {
          f.vel.y -= 7 * dt;
          f.m.position.addScaledVector(f.vel, dt);
          f.m.rotation.x += f.spin!.x * dt;
          f.m.rotation.y += f.spin!.y * dt;
          f.m.material.opacity = Math.min(1, k * 2);
        }
      }
    },
  };
}
