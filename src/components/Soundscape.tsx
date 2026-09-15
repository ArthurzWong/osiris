'use client';

/**
 * OSIRIS — Ambient Soundscape
 *
 * A single, seamlessly-looping background bed that runs under the whole
 * console, so the map reads as a living operations room rather than a silent
 * dashboard.
 *
 * Playback strategy (browsers forbid audible autoplay without a user gesture,
 * so a cold first visit cannot start sound on its own — this is the closest
 * behaviour that is actually permitted):
 *   1. Try to play the moment the page mounts. This succeeds for returning
 *      visitors, installed PWAs, and any origin the browser already trusts.
 *   2. If that is rejected, arm one-shot listeners and start on the very first
 *      interaction — click, tap, key or scroll. Listeners stay attached until
 *      playback actually starts, not merely until the first event fires.
 *   3. An explicit mute by the user is written to localStorage and is never
 *      overridden on a later visit.
 *
 * The <audio> element lives outside React (module singleton) so a breakpoint
 * change that unmounts a control surface can never interrupt playback, and
 * volume is always faded rather than switched so there is no click or jump.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, Pause, Play, Volume1, Volume2, VolumeX, X } from 'lucide-react';

const AUDIO_SRC = '/audio/osiris-soundscape.mp3';
const PREF_KEY = '***';
const DEFAULT_VOLUME = 0.35;
const FADE_IN_MS = 1800;
const FADE_OUT_MS = 900;

export type SoundState = {
  playing: boolean;
  volume: number;
  blocked: boolean;
  /** Autostart was armed but the browser has not let sound through yet. */
  waiting: boolean;
};

// ── Module-level store (survives remounts, one audio element per page) ──────

let audio: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();
let fadeHandle = 0;
let state: SoundState = { playing: false, volume: DEFAULT_VOLUME, blocked: false, waiting: false };
let snapshot: SoundState = state;

function notify() {
  snapshot = { ...state };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot() {
  return snapshot;
}

function readPref(): { volume: number; enabled: boolean; hasPref: boolean } {
  if (typeof window === 'undefined') return { volume: DEFAULT_VOLUME, enabled: false, hasPref: false };
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return { volume: DEFAULT_VOLUME, enabled: false, hasPref: false };
    const p = JSON.parse(raw) as { volume?: number; enabled?: boolean };
    return {
      volume:
        typeof p.volume === 'number' && Number.isFinite(p.volume)
          ? Math.max(0, Math.min(1, p.volume))
          : DEFAULT_VOLUME,
      enabled: Boolean(p.enabled),
      hasPref: true,
    };
  } catch {
    return { volume: DEFAULT_VOLUME, enabled: false, hasPref: false };
  }
}

function writePref(patch: { volume?: number; enabled?: boolean }) {
  if (typeof window === 'undefined') return;
  try {
    const cur = readPref();
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ volume: cur.volume, enabled: cur.enabled, ...patch }),
    );
  } catch {
    /* private mode / quota — the soundscape still works, it just won't persist */
  }
}

/** Pull the saved volume into the store exactly once per page. */
let hydrated = false;
function hydrateFromPref() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  const p = readPref();
  state = { ...state, volume: p.volume };
  notify();
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (audio) return audio;
  const el = new Audio(AUDIO_SRC);
  el.loop = true;
  el.preload = 'none';
  el.volume = 0;
  el.addEventListener('playing', () => {
    state = { ...state, playing: true, blocked: false, waiting: false };
    notify();
  });
  el.addEventListener('pause', () => {
    state = { ...state, playing: false };
    notify();
  });
  el.addEventListener('error', () => {
    state = { ...state, playing: false, blocked: true, waiting: false };
    notify();
  });
  audio = el;
  return el;
}

function fadeTo(target: number, ms: number, done?: () => void) {
  const el = audio;
  if (!el) return;
  if (fadeHandle) cancelAnimationFrame(fadeHandle);
  const from = el.volume;
  const start = performance.now();
  const tick = (now: number) => {
    const p = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
    el.volume = Math.max(0, Math.min(1, from + (target - from) * p));
    if (p < 1) {
      fadeHandle = requestAnimationFrame(tick);
    } else {
      fadeHandle = 0;
      done?.();
    }
  };
  fadeHandle = requestAnimationFrame(tick);
}

/**
 * @param silent  true for autostart attempts: a rejected play() is expected on
 *                a cold visit, so it must not raise the "blocked" warning.
 * @returns whether audio is actually running.
 */
export async function startSound({ silent = false }: { silent?: boolean } = {}): Promise<boolean> {
  const el = ensureAudio();
  if (!el) return false;
  try {
    if (el.paused) {
      el.volume = 0;
      await el.play();
    }
    fadeTo(state.volume, FADE_IN_MS);
    state = { ...state, blocked: false, waiting: false };
    writePref({ enabled: true });
    notify();
    return true;
  } catch {
    state = silent
      ? { ...state, playing: false, blocked: false, waiting: true }
      : { ...state, playing: false, blocked: true, waiting: false };
    notify();
    return false;
  }
}

export function stopSound() {
  // An explicit stop is a standing instruction — remember it so a later visit
  // does not start talking over the user again.
  writePref({ enabled: false });
  const el = ensureAudio();
  if (!el) return;
  fadeTo(0, FADE_OUT_MS, () => el.pause());
  state = { ...state, playing: false, blocked: false, waiting: false };
  notify();
}

export function setSoundVolume(v: number) {
  const vol = Math.max(0, Math.min(1, v));
  const el = ensureAudio();
  if (el && !el.paused) {
    if (fadeHandle) {
      cancelAnimationFrame(fadeHandle);
      fadeHandle = 0;
    }
    el.volume = vol;
  }
  state = { ...state, volume: vol };
  writePref({ volume: vol });
  notify();
}

export function toggleSound() {
  if (state.playing) stopSound();
  else void startSound();
}

// ── Autostart ──────────────────────────────────────────────────────────────

const GESTURES: string[] = ['pointerdown', 'mousedown', 'click', 'keydown', 'touchend', 'touchstart', 'scroll', 'wheel'];
let armed = false;

/**
 * Try to get sound running without waiting to be asked. Idempotent, and safe to
 * call from more than one mount point.
 */
export function armAutostart() {
  if (armed || typeof window === 'undefined') return;
  armed = true;

  hydrateFromPref();

  const pref = readPref();
  // A saved "off" is explicit. Never talk over that.
  if (pref.hasPref && !pref.enabled) return;

  // Buffer early so the bed starts the instant we are allowed to play it.
  const el = ensureAudio();
  if (el) {
    el.preload = 'auto';
    try {
      el.load();
    } catch {
      /* not fatal — playback still works, it just starts later */
    }
  }

  state = { ...state, waiting: true };
  notify();

  const detach = () => {
    GESTURES.forEach((t) => window.removeEventListener(t, kick, true));
  };

  // The first interaction is the only thing a cold visit is guaranteed to give
  // us. Keep listening until audio actually runs, because not every gesture is
  // a user activation in every browser (a scroll, for instance, is not).
  function kick() {
    if (state.playing) {
      detach();
      return;
    }
    void startSound({ silent: true }).then((ok) => {
      if (ok) detach();
    });
  }

  void startSound({ silent: true }).then((ok) => {
    if (ok) return;
    GESTURES.forEach((t) => window.addEventListener(t, kick, { capture: true, passive: true }));
  });
}

/** Mount once, renders nothing. Keeps autostart off the control surfaces. */
export function SoundscapeAutostart() {
  useEffect(() => {
    armAutostart();
    const el = ensureAudio();
    if (!el) return;
    // Chrome pauses media in backgrounded tabs only if asked; we don't. But if
    // the OS suspends the element on resume, nudge it back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && state.playing && el.paused) {
        void el.play().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return null;
}

// ── Controls ───────────────────────────────────────────────────────────────

function VolumeGlyph({ volume, playing }: { volume: number; playing: boolean }) {
  if (!playing || volume <= 0.01) return <VolumeX className="w-4 h-4" />;
  if (volume < 0.5) return <Volume1 className="w-4 h-4" />;
  return <Volume2 className="w-4 h-4" />;
}

function Mixer({ onClose, width }: { onClose: () => void; width: string }) {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const pct = Math.round(s.volume * 100);

  return (
    <div className={`glass-panel p-3 ${width}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <AudioLines className="w-3 h-3 text-[var(--cyan-primary)]" />
          <span className="text-[10px] font-mono font-bold tracking-widest text-[var(--text-heading)]">
            AMBIENT
          </span>
          <span
            className={`w-1 h-1 rounded-full ${s.playing ? 'bg-[var(--cyan-primary)] animate-osiris-pulse' : 'bg-white/25'}`}
            aria-hidden="true"
          />
        </div>
        <button
          onClick={onClose}
          aria-label="Close soundscape mixer"
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-[9px] font-mono text-[var(--text-muted)] leading-relaxed mb-3">
        Cinematic background bed, looped seamlessly. Runs under the console while you work the map.
      </p>

      <div className="flex items-center gap-2">
        <button
          onClick={toggleSound}
          aria-label={s.playing ? 'Pause ambient soundscape' : 'Play ambient soundscape'}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-[var(--cyan-primary)]/15 hover:bg-[var(--cyan-primary)]/25 border border-[var(--cyan-primary)]/30 transition-colors flex-shrink-0"
        >
          {s.playing ? (
            <Pause className="w-3.5 h-3.5 text-[var(--cyan-primary)]" />
          ) : (
            <Play className="w-3.5 h-3.5 text-[var(--cyan-primary)] translate-x-[1px]" />
          )}
        </button>

        <button
          onClick={() => {
            setSoundVolume(s.volume > 0.01 ? 0 : DEFAULT_VOLUME);
          }}
          aria-label={s.volume > 0.01 ? 'Mute ambient soundscape' : 'Unmute ambient soundscape'}
          className="text-white/60 hover:text-white transition-colors flex-shrink-0"
        >
          <VolumeGlyph volume={s.volume} playing={s.playing} />
        </button>

        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={s.volume}
          onChange={(e) => setSoundVolume(Number(e.target.value))}
          aria-label="Ambient soundscape volume"
          className="osiris-audio-range flex-1 min-w-0"
        />

        <span className="text-[9px] font-mono text-[var(--gold-primary)] tabular-nums w-8 text-right flex-shrink-0">
          {pct}%
        </span>
      </div>

      {s.waiting && (
        <div className="mt-2 text-[9px] font-mono text-[#FFB800] leading-relaxed">
          Sound starts on your first click or keypress.
        </div>
      )}
      {s.blocked && (
        <div className="mt-2 text-[9px] font-mono text-[#FFB800] leading-relaxed">
          Browser blocked autoplay — press play to allow audio.
        </div>
      )}
    </div>
  );
}

export function SoundscapeRailControl() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [open, setOpen] = useState(false);

  const onToggle = () => {
    if (s.playing) {
      stopSound();
      setOpen(false);
    } else {
      void startSound();
      setOpen(true);
    }
  };

  return (
    <div className="relative group">
      <button
        onClick={onToggle}
        className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50 ${
          s.playing ? 'bg-[var(--cyan-primary)]/20' : 'hover:bg-white/10'
        }`}
        title="Ambient — cinematic background soundscape"
        aria-label="Ambient soundscape"
        aria-pressed={s.playing}
      >
        <AudioLines className={`w-4 h-4 ${s.playing ? 'text-[var(--cyan-primary)]' : 'text-white/60'}`} />
        {s.playing && (
          <span
            aria-hidden="true"
            className="absolute -right-1 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-full bg-current text-[var(--cyan-primary)]"
          />
        )}
        {s.waiting && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-1 ring-[var(--cyan-primary)]/50 animate-osiris-pulse"
          />
        )}
      </button>
      <span className="absolute right-11 top-1/2 -translate-y-1/2 px-2 py-1 text-[9px] font-mono tracking-wider text-white/80 bg-black/80 backdrop-blur-sm rounded whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity pointer-events-none">
        AMBIENT
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="absolute right-12 top-1/2 -translate-y-1/2 w-64"
          >
            <Mixer onClose={() => setOpen(false)} width="w-64" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function SoundscapeInlineControl() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [open, setOpen] = useState(false);

  const onToggle = () => {
    if (s.playing) {
      stopSound();
      setOpen(false);
    } else {
      void startSound();
      setOpen(true);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={`relative glass-panel w-8 h-8 rounded-full flex items-center justify-center transition-opacity ${
          s.playing ? 'border-[var(--cyan-primary)]/40 bg-[var(--cyan-primary)]/10' : 'hover:opacity-80'
        }`}
        title="Ambient soundscape"
        aria-label="Ambient soundscape"
        aria-pressed={s.playing}
      >
        <AudioLines className={`w-3.5 h-3.5 ${s.playing ? 'text-[var(--cyan-primary)]' : 'text-white/60'}`} />
        {s.waiting && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-1 ring-[var(--cyan-primary)]/50 animate-osiris-pulse"
          />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            className="absolute top-10 right-0 z-[260]"
          >
            <Mixer onClose={() => setOpen(false)} width="w-60" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
