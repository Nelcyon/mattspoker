// Per-device choices (sound, vibration, screen awake, card colours, text size).
import { useSyncExternalStore } from 'react';

export interface Prefs {
  sound: boolean;
  vibrate: boolean;
  keepAwake: boolean;
  fourColor: boolean;
  bigText: boolean;
}

const DEFAULTS: Prefs = { sound: true, vibrate: true, keepAwake: true, fourColor: false, bigText: false };

let prefs: Prefs = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pn:prefs') ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
})();
const listeners = new Set<() => void>();

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs = { ...prefs, [k]: v };
  try {
    localStorage.setItem('pn:prefs', JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function getPrefs() {
  return prefs;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

// ---- Sounds (generated, no files) ----
let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers only allow sound after a tap; call this from any tap. */
export function unlockAudio() {
  audio();
}

function tone(freq: number, start: number, dur: number, vol = 0.12, type: OscillatorType = 'sine') {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = a.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sounds = {
  yourTurn() {
    if (prefs.sound) {
      tone(660, 0, 0.18);
      tone(880, 0.14, 0.25);
    }
    if (prefs.vibrate) navigator.vibrate?.([120, 60, 120]);
  },
  chip() {
    if (prefs.sound) tone(1800, 0, 0.05, 0.05, 'triangle');
  },
  card() {
    if (prefs.sound) tone(400, 0, 0.04, 0.04, 'triangle');
  },
  win() {
    if (prefs.sound) {
      tone(523, 0, 0.15);
      tone(659, 0.12, 0.15);
      tone(784, 0.24, 0.3);
    }
  },
};

// ---- Keep the screen on while at the table ----
let lock: { release(): Promise<void> } | null = null;
export async function keepAwake(on: boolean) {
  try {
    if (on && document.visibilityState === 'visible' && !lock && 'wakeLock' in navigator) {
      lock = await (navigator as Navigator & { wakeLock: { request(t: 'screen'): Promise<{ release(): Promise<void>; addEventListener(e: string, f: () => void): void }> } }).wakeLock.request('screen');
      (lock as unknown as { addEventListener(e: string, f: () => void): void }).addEventListener('release', () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}
