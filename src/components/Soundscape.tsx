'use client';

/**
 * OSIRIS — Ambient Soundscape
 *
 * A single, seamlessly-looping background bed that runs under the whole
 * console, so the map reads as a living operations room rather than a silent
 * dashboard.
 *
 * Starting sound nobody asked for is impossible on the web: browsers refuse to
 * begin *audible* playback without a gesture. The closest legal behaviour, and
 * what this does:
 *   1. Try to play audibly the instant the page mounts. Trusted origins,
 *      returning visitors and installed PWAs simply start.
 *   2. If that is refused, start the bed MUTED — always permitted — so it is
 *      already running and buffered. The first click, tap, key or scroll then
 *      only has to unmute it, so sound appears instantly instead of after a
 *      2.3 MB round trip.
 *
 * Two rules learned the hard way:
 *   - An on/off toggle must never become a permanent, invisible opt-out. Muting
 *     is therefore session-scoped (sessionStorage), while only the volume is
 *     remembered across visits. A stale `enabled:false` from an earlier build
 *     is ignored and purged.
 *   - Silence must never be indistinguishable from a bug: if the bed is waiting
 *     on a gesture, the control says so.
 *
 * The <audio> element lives outside React (module singleton) so a breakpoint
 * change that unmounts a control surface can never interrupt playback, and
 * volume is always faded rather than switched so there is no click or jump.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, Pause, Play, Volume1, Volume2, VolumeX, X } from 'lucide-react';

const AUDIO_SRC = '/audio/osiris-soundscape.mp3';
const PREF_KEY = 'osiris…s.v2';
const MUTE_KEY = 'osiris…s.v2.muted';
const DEFAULT_VOLUME = 0.7;
const FADE_IN_MS = 1800;
const FADE_OUT_MS = 900;

export type SoundState = {
  /** Audible output is actually running. */
  playing: boolean;
  volume: number;
  /** User pressed play and the browser refused; tell them. */
  blocked: boolean;
  /** Bed is running muted, waiting for a gesture to become audible. */
  waiting: boolean;
  /** Show the one-time "sound is on" confirmation. */
  announce: boolean;
};

// ── Module-level store (survives remounts, one audio element per page) ──────

let audio: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();
let fadeHandle = 0;
let state: SoundState = { playing: false, volume: DEFAULT_VOLUME, blocked: false, waiting: false, announce: false };
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

/**
 * A one-time, self-dismissing confirmation. Without it, "silent because the tab
 * is muted" and "silent because the feature is broken" look identical — which is
 * exactly the hole this feature fell into.
 */
let announceTimer = 0;
function announceOn() {
  if (typeof window === 'undefined') return;
  state = { ...state, announce: true };
  notify();
  if (announceTimer) window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    state = { ...state, announce: false };
    notify();
  }, 4500);
}

function safeGet(store: Storage | undefined, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}
function safeSet(store: Storage | undefined, key: string, value: string) {
  try {
    store?.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

/**
 * The first build persisted `{ volume, enabled }` and read `enabled` as a
 * permanent opt-out, so a single on/off click silently disabled the bed for that
 * browser forever. Only the volume is honoured now, and any leftover entry with
 * an `enabled` field is deleted.
 *
 * Matching on the value's shape, not on the key's name, is deliberate: the old
 * key was not a documented constant and naming it here would be brittle.
 */
function purgeLegacyPrefs() {
  if (typeof window === 'undefined') return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || k === PREF_KEY || k === MUTE_KEY) continue;
      let v: unknown = null;
      try {
        v = JSON.parse(window.localStorage.getItem(k) || 'null');
      } catch {
        continue;
      }
      if (v && typeof v === 'object' && 'enabled' in (v as Record<string, unknown>)) stale.push(k);
    }
    stale.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* nothing we can do, and nothing that matters */
  }
}

/** Volume is the only thing worth remembering across visits. */
function readPref(): number {
  if (typeof window === 'undefined') return DEFAULT_VOLUME;
  try {
    const raw = safeGet(window.localStorage, PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { volume?: number };
      if (typeof p.volume === 'number' && Number.isFinite(p.volume)) {
        return Math.max(0, Math.min(1, p.volume));
      }
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_VOLUME;
}

function writePref(volume: number) {
  if (typeof window === 'undefined') return;
  safeSet(window.localStorage, PREF_KEY, JSON.stringify({ volume }));
}

function isSessionMuted() {
  if (typeof window === 'undefined') return false;
  return safeGet(window.sessionStorage, MUTE_KEY) === '1';
}
function setSessionMuted(on: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (on) window.sessionStorage.setItem(MUTE_KEY, '1');
    else window.sessionStorage.removeItem(MUTE_KEY);
  } catch {
    /* ignore */
  }
}

let hydrated = false;
function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  state = { ...state, volume: readPref() };
  notify();
}

function wire(el: HTMLAudioElement) {
  if (el.dataset.osirisWired === '1') return;
  el.dataset.osirisWired = '1';
  el.loop = true;
  el.volume = 0;

  // Derived from the element itself rather than from our own bookkeeping, so the
  // UI can never claim sound is playing when it is not (and vice versa).
  const sync = () => {
    const audible = !el.paused && !el.muted && el.volume > 0.001;
    const waiting = !el.paused && el.muted;
    if (audible !== state.playing || waiting !== state.waiting) {
      state = { ...state, playing: audible, waiting };
      notify();
    }
  };
  el.addEventListener('playing', sync);
  el.addEventListener('pause', sync);
  el.addEventListener('volumechange', sync);
  el.addEventListener('error', () => {
    state = { ...state, playing: false, blocked: true, waiting: false };
    notify();
  });
}

/** The hidden <audio> element that SoundscapeAutostart renders, once mounted. */
export function attachElement(el: HTMLAudioElement | null) {
  if (typeof window === 'undefined' || !el || audio === el) return;
  audio = el;
  wire(el);
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (audio) return audio;
  // Fallback for the moment before the rendered element mounts.
  const el = new Audio(AUDIO_SRC);
  el.preload = 'none';
  audio = el;
  wire(el);
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

/** Get the bed running, silently. Muted playback is always allowed. */
async function startMuted(): Promise<boolean> {
  const el = ensureAudio();
  if (!el) return false;
  try {
    el.muted = true;
    el.volume = 0;
    if (el.paused) await el.play();
    state = { ...state, blocked: false };
    notify();
    return !el.paused;
  } catch {
    return false;
  }
}

/** Get the bed running audibly. Requires a gesture on a cold visit. */
async function startAudible(): Promise<boolean> {
  const el = ensureAudio();
  if (!el) return false;
  try {
    if (el.paused) {
      el.muted = false;
      el.volume = 0;
      await el.play();
    } else {
      el.muted = false;
    }
    fadeTo(state.volume, FADE_IN_MS);
    state = { ...state, blocked: false, waiting: false, playing: true };
    announceOn();
    setSessionMuted(false);
    writePref(state.volume);
    notify();
    return true;
  } catch {
    // The caller decides what happens next: armAutostart primes a muted bed,
    // an explicit play surfaces the block. Racing both here just aborts itself.
    return false;
  }
}

export async function startSound(): Promise<boolean> {
  const ok = await startAudible();
  if (!ok) {
    state = { ...state, playing: false, blocked: true, waiting: false };
    notify();
  }
  return ok;
}

export function stopSound() {
  // Session-scoped on purpose: silencing the room now must not mean silence
  // forever on the next visit.
  setSessionMuted(true);
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
  state = { ...state, volume: vol, playing: vol > 0.001 && !!el && !el.paused && !el.muted };
  writePref(vol);
  notify();
}

export function toggleSound() {
  if (state.playing) stopSound();
  else void startSound();
}

// ── Autostart ──────────────────────────────────────────────────────────────

const GESTURES = ['pointerdown', 'mousedown', 'click', 'keydown', 'touchend', 'touchstart', 'scroll', 'wheel'];
let armed = false;

export function armAutostart() {
  if (armed || typeof window === 'undefined') return;
  armed = true;

  purgeLegacyPrefs();
  hydrate();

  // The visitor silenced it in this session. Respect that, and say so.
  if (isSessionMuted()) return;

  // Buffer while we try, so the unmute is instant.
  const el = ensureAudio();
  if (el) {
    el.preload = 'auto';
    try {
      el.load();
    } catch {
      /* not fatal */
    }
  }

  const detach = () => GESTURES.forEach((t) => window.removeEventListener(t, kick, true));

  // Listeners stay attached until sound is genuinely audible: not every gesture
  // is a user activation in every browser (a scroll is not, in Chrome), and a
  // single missed one would otherwise leave the page silent forever.
  function kick() {
    if (state.playing) {
      detach();
      return;
    }
    void startAudible().then((ok) => {
      if (ok) detach();
    });
  }

  void (async () => {
    if (await startAudible()) return;

    // Muted playback is normally allowed and makes the later unmute instant,
    // but it is only an optimisation. If even that is refused we still simply
    // wait for a gesture. Either way the honest state is "waiting", never
    // "blocked" — the visitor has not asked for anything yet.
    await startMuted();
    state = { ...state, waiting: true, blocked: false };
    notify();

    GESTURES.forEach((t) => window.addEventListener(t, kick, { capture: true, passive: true }));
  })();
}

/** Mount once: renders the hidden audio element, arms autostart, and shows the
 *  one-time confirmation. Keeps all of that off the control surfaces. */
export function SoundscapeAutostart() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    attachElement(ref.current);
    armAutostart();

    // Some browsers hand activation back on focus rather than on the original
    // gesture, and media suspended in a background tab needs a nudge.
    const el = ensureAudio();
    const onWake = () => {
      if (!el) return;
      if (state.playing && el.paused) void el.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, []);

  return (
    <>
      {/* Hidden by geometry rather than display:none — some engines refuse to
          play a media element that is not rendered at all. */}
      <audio
        ref={ref}
        src={AUDIO_SRC}
        loop
        preload="auto"
        playsInline
        aria-hidden="true"
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />
      <AnimatePresence>
        {s.announce && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[300] pointer-events-none glass-panel px-3 py-1.5 flex items-center gap-2"
          >
            <Volume2 className="w-3 h-3 text-[var(--cyan-primary)]" />
            <span className="text-[9px] font-mono tracking-widest text-[var(--text-primary)]">
              AMBIENT ON &#183; PRESS A TO MUTE
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
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
          onClick={() => setSoundVolume(s.volume > 0.01 ? 0 : DEFAULT_VOLUME)}
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
          Ready and buffered — click or press any key to bring the sound up.
        </div>
      )}
      {s.blocked && (
        <div className="mt-2 text-[9px] font-mono text-[#FFB800] leading-relaxed">
          The browser blocked audio. Press play to allow it.
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
