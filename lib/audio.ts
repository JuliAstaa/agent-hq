// Sound for Agent HQ (deviation 13): background music from a user-supplied file plus synthesized sound effects
// (Web Audio, no sound files, so nothing to license). Separate music and effects volumes plus a mute switch, all
// remembered per browser. Effects go through a compressor so a sudden portal never jumps out. Browsers allow
// audio only after a user gesture, so playback starts on the first click after unmuting.
// Framework-free; React reads `audioStore`, the engine asks for effects with a DOM event (see `SFX_EVENT`).

import { createStore } from "zustand/vanilla";

/** Background music: public/audio/agent-hq.mp3 (the user's own track), or NEXT_PUBLIC_HQ_BGM for another URL. */
export const BGM_URL = process.env.NEXT_PUBLIC_HQ_BGM || "/audio/agent-hq.mp3";
/** DOM event the engine dispatches (bubbling) to play an effect: detail = { kind, pan?, intensity? }. */
export const SFX_EVENT = "hq:sfx";

export type SfxKind = "portal-open" | "portal-close" | "ship-pass" | "meteor" | "airlock-alarm" | "airlock" | "twinkle";
export interface SfxDetail {
  kind: SfxKind;
  /** Stereo position, -1 (left) .. 1 (right). */
  pan?: number;
  /** 0..1, scales loudness (for example a far-away meteor). */
  intensity?: number;
}

export type BgmState = "off" | "loading" | "playing" | "blocked" | "missing";
export interface AudioState {
  muted: boolean;
  /** Music volume 0..1 (slider position). */
  music: number;
  /** Sound-effects volume 0..1 (slider position). */
  sfx: number;
  bgm: BgmState;
}
type Prefs = Pick<AudioState, "muted" | "music" | "sfx">;

const STORAGE_KEY = "agenthq.audio";
export const DEFAULTS: AudioState = { muted: true, music: 0.5, sfx: 0.4, bgm: "off" };

export const clampVolume = (v: number, fallback = 0.5) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
/** Slider position -> gain. Squared, so the lower half of the slider is usable (hearing is roughly logarithmic). */
export const gainOf = (v: number) => v * v;

/** Saved preferences. The first version stored one `volume`: it becomes the music volume, effects start at default. */
export function parsePrefs(raw: unknown): Prefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    muted: r.muted !== false,
    music: clampVolume(Number(r.music ?? r.volume ?? DEFAULTS.music), DEFAULTS.music),
    sfx: clampVolume(Number(r.sfx ?? DEFAULTS.sfx), DEFAULTS.sfx),
  };
}
function loadPrefs(): Prefs {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return parsePrefs(null);
  }
}
function savePrefs(s: AudioState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted: s.muted, music: s.music, sfx: s.sfx }));
  } catch {}
}

export const audioStore = createStore<AudioState>(() => ({ ...DEFAULTS }));

/* ---------------- runtime (browser only) ---------------- */

let bgm: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let refs = 0;
let waitingGesture = false;

const sfxGain = (s: AudioState) => (s.muted ? 0 : gainOf(s.sfx));
const musicGain = (s: AudioState) => (s.muted ? 0 : gainOf(s.music));

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = sfxGain(audioStore.getState());
  // Soft limiter: loud moments (portal opening, meteor rumble) are evened out instead of startling.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -20;
  limiter.knee.value = 12;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function ensureBgm(): HTMLAudioElement {
  if (bgm) return bgm;
  const el = new Audio();
  el.loop = true;
  el.preload = "auto";
  // Ignore events from an element that was already torn down (StrictMode remount, page leave).
  el.addEventListener("error", () => el === bgm && audioStore.setState({ bgm: "missing" }));
  el.addEventListener("playing", () => el === bgm && audioStore.setState({ bgm: "playing" }));
  el.src = BGM_URL;
  bgm = el;
  return el;
}

function applyVolume() {
  const s = audioStore.getState();
  if (master && ctx) master.gain.setTargetAtTime(sfxGain(s), ctx.currentTime, 0.05);
  if (bgm) bgm.volume = musicGain(s);
}

const stopMusic = () => {
  bgm?.pause();
  const b = audioStore.getState().bgm;
  if (b === "playing" || b === "loading" || b === "blocked") audioStore.setState({ bgm: "off" });
};

/** Start or stop sound to match the current state. Call from a user gesture when possible. */
function sync() {
  if (typeof window === "undefined") return;
  const s = audioStore.getState();
  applyVolume();
  if (s.muted) return stopMusic();
  const c = ensureContext();
  if (c && c.state === "suspended") c.resume().catch(() => {});
  if (s.music === 0) return stopMusic(); // effects only
  const el = ensureBgm();
  applyVolume();
  if (audioStore.getState().bgm === "missing") return;
  if (!el.paused) return;
  audioStore.setState({ bgm: "loading" });
  el.play().catch((e: Error) => {
    if (e.name === "NotAllowedError") {
      audioStore.setState({ bgm: "blocked" });
      waitForGesture();
    } else if (audioStore.getState().bgm !== "missing") audioStore.setState({ bgm: "missing" });
  });
}

/** Autoplay was refused: start on the next click or key press anywhere. */
function waitForGesture() {
  if (waitingGesture) return;
  waitingGesture = true;
  const go = () => {
    window.removeEventListener("pointerdown", go, true);
    window.removeEventListener("keydown", go, true);
    waitingGesture = false;
    if (!audioStore.getState().muted) sync();
  };
  window.addEventListener("pointerdown", go, true);
  window.addEventListener("keydown", go, true);
}

export function setMuted(muted: boolean) {
  audioStore.setState({ muted });
  savePrefs(audioStore.getState());
  sync();
}
export const toggleMuted = () => setMuted(!audioStore.getState().muted);

/** Moving a slider above zero while muted also unmutes (the user wants to hear it). */
function setLevel(key: "music" | "sfx", value: number) {
  const v = clampVolume(value, DEFAULTS[key]);
  audioStore.setState({ [key]: v, ...(v > 0 && audioStore.getState().muted ? { muted: false } : {}) });
  savePrefs(audioStore.getState());
  sync();
}
export const setMusicVolume = (v: number) => setLevel("music", v);
export const setSfxVolume = (v: number) => setLevel("sfx", v);

/* ---------------- synthesized effects ---------------- */

function voice(c: AudioContext, pan = 0, intensity = 1) {
  const out = c.createGain();
  out.gain.value = Math.min(1, Math.max(0.05, intensity));
  if (c.createStereoPanner) {
    const p = c.createStereoPanner();
    p.pan.value = Math.min(1, Math.max(-1, pan));
    out.connect(p).connect(master!);
    return { out, pan: p.pan as AudioParam | null };
  }
  out.connect(master!);
  return { out, pan: null as AudioParam | null };
}

function noiseSource(c: AudioContext) {
  const src = c.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  return src;
}

/** Moving sounds drift a little to the right of where they start (the caller sets the start from the screen). */
function drift(pan: AudioParam | null, t: number, d: number, by: number) {
  if (!pan) return;
  const p0 = pan.value;
  pan.setValueAtTime(p0, t);
  pan.linearRampToValueAtTime(Math.min(1, p0 + by), t + d);
}

/** Envelope helper: 0 -> peak at `a` s -> 0 at `end` s (exponential tail). */
function env(g: GainNode, t: number, peak: number, a: number, end: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + end);
}

const SYNTH: Record<SfxKind, (c: AudioContext, out: GainNode, pan: AudioParam | null) => number> = {
  // A deep "whomp" that swells into a shimmering hum.
  "portal-open": (c, out) => {
    const t = c.currentTime;
    const low = c.createOscillator(), lg = c.createGain();
    low.type = "sine";
    low.frequency.setValueAtTime(70, t);
    low.frequency.exponentialRampToValueAtTime(190, t + 0.7);
    env(lg, t, 0.32, 0.18, 1.4);
    low.connect(lg).connect(out);
    const n = noiseSource(c), bp = c.createBiquadFilter(), ng = c.createGain();
    bp.type = "bandpass";
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.9);
    env(ng, t, 0.2, 0.5, 1.6);
    n.connect(bp).connect(ng).connect(out);
    const shimmer = [660, 993].map((f) => {
      const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg2 = c.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      lfo.frequency.value = 9;
      lg2.gain.value = 0.04;
      lfo.connect(lg2).connect(g.gain);
      env(g, t + 0.2, 0.05, 0.5, 2.0);
      o.connect(g).connect(out);
      return [o, lfo];
    });
    for (const s of [low, n, ...shimmer.flat()]) {
      s.start(t);
      s.stop(t + 2.2);
    }
    return 2.2;
  },
  // A quick downward suck and a soft pop.
  "portal-close": (c, out) => {
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.45);
    env(g, t, 0.28, 0.04, 0.55);
    o.connect(g).connect(out);
    const n = noiseSource(c), lp = c.createBiquadFilter(), ng = c.createGain();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2500, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
    env(ng, t + 0.35, 0.16, 0.02, 0.6);
    n.connect(lp).connect(ng).connect(out);
    for (const s of [o, n]) {
      s.start(t);
      s.stop(t + 0.8);
    }
    return 0.8;
  },
  // A small craft buzzing past: engine hum with a falling pitch, swept left to right.
  "ship-pass": (c, out, pan) => {
    const t = c.currentTime, d = 2.6;
    const o = c.createOscillator(), og = c.createGain(), vib = c.createOscillator(), vg = c.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(150, t);
    o.frequency.linearRampToValueAtTime(95, t + d);
    vib.frequency.value = 7;
    vg.gain.value = 4;
    vib.connect(vg).connect(o.frequency);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    env(og, t, 0.12, d * 0.45, d);
    o.connect(lp).connect(og).connect(out);
    const n = noiseSource(c), bp = c.createBiquadFilter(), ng = c.createGain();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(1800, t + d * 0.45);
    bp.frequency.linearRampToValueAtTime(500, t + d);
    env(ng, t, 0.15, d * 0.45, d);
    n.connect(bp).connect(ng).connect(out);
    drift(pan, t, d, 0.35);
    for (const s of [o, vib, n]) {
      s.start(t);
      s.stop(t + d + 0.1);
    }
    return d + 0.1;
  },
  // Rushing air with a low rumble and crackles, swept across.
  meteor: (c, out, pan) => {
    const t = c.currentTime, d = 3.2;
    const n = noiseSource(c), lp = c.createBiquadFilter(), ng = c.createGain();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3500, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + d);
    env(ng, t, 0.26, d * 0.35, d);
    n.connect(lp).connect(ng).connect(out);
    const r = c.createOscillator(), rg = c.createGain();
    r.type = "sine";
    r.frequency.setValueAtTime(58, t);
    r.frequency.linearRampToValueAtTime(38, t + d);
    env(rg, t, 0.2, d * 0.4, d);
    r.connect(rg).connect(out);
    const crackle = noiseSource(c), hp = c.createBiquadFilter(), cg = c.createGain();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    cg.gain.setValueAtTime(0, t);
    for (let k = 0; k < 14; k++) {
      const at = t + 0.2 + Math.random() * (d * 0.7);
      cg.gain.setValueAtTime(0.08 * Math.random() + 0.03, at);
      cg.gain.setValueAtTime(0, at + 0.03);
    }
    crackle.connect(hp).connect(cg).connect(out);
    drift(pan, t, d, 0.45);
    for (const s of [n, r, crackle]) {
      s.start(t);
      s.stop(t + d + 0.1);
    }
    return d + 0.1;
  },
  // Airlock (prd.md §7.10): two-tone warning beeps while a kicked agent waits inside.
  "airlock-alarm": (c, out) => {
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "square";
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 4; k++) {
      const at = t + k * 0.3;
      o.frequency.setValueAtTime(k % 2 ? 660 : 880, at);
      g.gain.setValueAtTime(0.07, at);
      g.gain.setValueAtTime(0, at + 0.2);
    }
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    o.connect(lp).connect(g).connect(out);
    o.start(t);
    o.stop(t + 1.25);
    return 1.25;
  },
  // The hatch blows open: a rushing hiss of air, and the agent's falling "wheee" as it tumbles away.
  airlock: (c, out, pan) => {
    const t = c.currentTime, d = 2.4;
    const n = noiseSource(c), bp = c.createBiquadFilter(), ng = c.createGain();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(5000, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + d);
    ng.gain.setValueAtTime(0.0001, t); // silent until the hatch opens
    env(ng, t + 0.45, 0.3, 0.06, d);
    n.connect(bp).connect(ng).connect(out);
    const o = c.createOscillator(), og = c.createGain(), vib = c.createOscillator(), vg = c.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(900, t + 0.6);
    o.frequency.exponentialRampToValueAtTime(260, t + d);
    vib.frequency.value = 11;
    vg.gain.value = 30;
    vib.connect(vg).connect(o.frequency);
    og.gain.setValueAtTime(0.0001, t);
    env(og, t + 0.6, 0.09, 0.15, d);
    o.connect(og).connect(out);
    drift(pan, t, d, 0.4);
    for (const s of [n, o, vib]) {
      s.start(t);
      s.stop(t + d + 0.1);
    }
    return d + 0.1;
  },
  // A tiny sparkle where the agent disappears.
  twinkle: (c, out) => {
    const t = c.currentTime;
    [1568, 2093, 2637].forEach((f, k) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      env(g, t + k * 0.07, 0.06, 0.01, 0.35 + k * 0.07);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.6);
    });
    return 0.6;
  },
};

/** Play an effect now. No-op when muted, before the first gesture, or without Web Audio. */
export function playSfx({ kind, pan = 0, intensity = 1 }: SfxDetail) {
  const s = audioStore.getState();
  if (s.muted || s.sfx === 0 || !ctx || !master || ctx.state !== "running" || !SYNTH[kind]) return;
  const { out, pan: p } = voice(ctx, pan, intensity);
  const dur = SYNTH[kind](ctx, out, p);
  setTimeout(() => out.disconnect(), (dur + 0.3) * 1000);
}

/** "Tes" button in the settings: a short effect at the current level (called from a click, so audio may start). */
export function previewSfx() {
  if (audioStore.getState().muted) return;
  sync();
  const c = ctx;
  if (!c) return;
  const go = () => playSfx({ kind: "portal-close" });
  if (c.state === "running") go();
  else c.resume().then(go, () => {});
}

const onSfxEvent = (e: Event) => {
  const d = (e as CustomEvent<SfxDetail>).detail;
  if (d && typeof d.kind === "string") playSfx(d);
};

/**
 * Start the audio system (called by the sound control when it mounts; reference-counted for StrictMode).
 * Restores the saved preference; when it was "on", sound starts on the first user gesture.
 * Returns a cleanup function.
 */
export function initAudio(): () => void {
  if (typeof window === "undefined") return () => {};
  refs++;
  if (refs === 1) {
    audioStore.setState({ ...loadPrefs(), bgm: "off" });
    document.addEventListener(SFX_EVENT, onSfxEvent);
    if (!audioStore.getState().muted) waitForGesture();
  }
  return () => {
    refs--;
    if (refs > 0) return;
    document.removeEventListener(SFX_EVENT, onSfxEvent);
    bgm?.pause();
    if (bgm) bgm.src = "";
    bgm = null;
    ctx?.close().catch(() => {});
    ctx = null;
    master = null;
    noise = null;
  };
}
