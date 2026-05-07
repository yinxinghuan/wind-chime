import { useEffect, useRef, useState } from 'react';
import './WindChime.less';

// ─────────────────────────────────────────────────────────────────────────────
// Wind Chime — a quiet courtyard. Tap a brass tube to set it ringing; chimes
// jostle each other on the way back down and trigger their neighbors. A faint
// breeze stirs them while you watch. No goal, no score — just pentatonic
// resonance and slow drifting mist.
// ─────────────────────────────────────────────────────────────────────────────

// Pentatonic G-minor across 1.5 octaves — every combination resolves softly.
//                       G3      Bb3     C4      D4      F4      G4      Bb4
const FREQS = [196.00, 233.08, 261.63, 293.66, 349.23, 392.00, 466.16];

// Lengths are inverse-square-root proportional to frequency for tubes-in-air,
// but for *visual* pleasure we exaggerate: longest left, fanning shorter to
// the right. Values are fractions of canvas height.
const LEN_FRAC = [0.58, 0.54, 0.50, 0.46, 0.42, 0.39, 0.36];

// Tube outer radius (half-width). Lower notes get fatter tubes — adds visual
// hierarchy and matches reality (lower-pitched chimes are usually thicker).
const TUBE_R = [13, 12, 11, 10.5, 10, 9.5, 9];

const N = FREQS.length;
// Pendulum tuning. The longest tube (L≈489px) has a natural period of ~9.4 s
// (very slow, drifty) with damping ratio ζ≈0.14 — chimes oscillate clearly
// then settle in ~9-10 seconds. Iteration: 12 (initial, stuck-at-clamp bug)
// → 2500 (heavy) → 350 (better) → 220 (current, airier per user feedback).
const GRAVITY = 220;                 // px/s² equivalent — gentle restoring, ~9.4 s natural period
const DAMPING = 0.22;                // per-second angular damping (very lightly damped)
const TAP_IMPULSE = 0.55;            // graceful — swings to ~40°, well clear of MAX_ANGLE
const COLLIDE_RESTITUTION = 0.55;
const RING_VEL_THRESHOLD = 0.18;     // back to lighter — soft contacts now ring softly
const RING_COOLDOWN_MS = 110;        // a single chime can't ring more than this often
const MAX_ANGLE = 0.95;              // ~54° — beyond this physics looks wrong + tubes overlap massively
const COLLISION_GAP = 1.2;           // post-resolution separation in px to prevent re-touching
const WIND_FORCE_SCALE = 0.40;       // multiplier on wind acceleration (chime) — restores feathery drift
const STRIKER_WIND_SCALE = 0.34;     // striker catches more wind (leaf surface) but its mass is bigger
// Glow trigger: instead of lighting up on collision (the original behavior),
// the brass tubes now glint based on tilt angle — like real polished metal
// catching the moonlight when its face is angled toward the light. Below
// GLOW_THRESHOLD they're matte; above it the glint ramps quadratically.
const GLOW_THRESHOLD = 0.20;         // ~11° tilt before any glint shows
const GLOW_GAIN = 1.4;               // overall brightness multiplier on the quadratic ramp

// ─────────────────────────────────────────────────────────────────────────────
// THEMES
// ─────────────────────────────────────────────────────────────────────────────
// Three "instruments" sharing the same pentatonic G-minor pitch set but with
// distinct materials (sky, sub-elements, tube material, audio timbre, title
// script). Each pulls from a different exotic-script tradition for the title
// to give US users a sense of "elsewhere".

export type ThemeId = 'brass' | 'ceramic' | 'bamboo';

interface SkyStops { top: string; mid: string; bottom: string }

interface ThemeConfig {
  id: ThemeId;
  switchGlyph: string;                 // first character of the title script
  switchFont: string;                  // CSS font-family for the switcher glyph
  // Atmosphere
  sky: SkyStops;                       // 3-stop vertical gradient
  hasMoon: boolean;
  hasStars: boolean;
  hasMist: boolean;
  hasClouds: boolean;
  hasBambooLeaves: boolean;
  hasBirds: boolean;
  vignetteAlpha: number;               // edge darkening intensity
  beamColors: { top: string; mid: string; bottom: string };
  eyeletColor: string;
  // Tube material — eight horizontal gradient stops at fixed positions
  tubeStops: (hue: number) => string[]; // length 8, mapped to [0, 0.10, 0.28, 0.42, 0.65, 0.88, 0.97, 1.0]
  tubeVertGrad: { top: string; bottom: string };
  tubeSpec: string;                    // narrow specular line color (rgba())
  ridgeAlpha: number;                  // horizontal lathe-line darkness
  patinaColor: string;
  capColors: { center: string; mid: string; rim: string };
  rimGlow: string;                     // bottom-edge inner glow
  innerShadow: { top: string; bottom: string };
  // Title
  title: string;
  titleFont: string;
  titleSize: number;
  titleLetterSpacing: string;
  titleOffsetX: number;                // optical centering correction (some scripts need a nudge)
  titleAlpha: number;
  subtitleAlpha: number;
  // Foreground text color (title, subtitle, hint, switcher) — needs to invert
  // between dark-sky (cream) and light-sky (deep tone) themes.
  textColor: { r: number; g: number; b: number };
}

const THEMES: Record<ThemeId, ThemeConfig> = {
  // ── BRASS — moonlit night, aged-brass tubes (the original) ─────────────────
  brass: {
    id: 'brass',
    switchGlyph: '風',
    switchFont: '"Noto Serif SC", "Cormorant Garamond", serif',
    sky: { top: '#0a141c', mid: '#162028', bottom: '#243038' },
    hasMoon: true, hasStars: true, hasMist: true,
    hasClouds: false, hasBambooLeaves: false, hasBirds: false,
    vignetteAlpha: 0.42,
    beamColors: { top: '#0a0908', mid: '#1c1612', bottom: '#0a0807' },
    eyeletColor: '#a8895a',
    tubeStops: (hue) => {
      const hs = (n: number) => Math.floor(hue * n);
      return [
        `rgb(${48 + hs(8)}, ${36 + hs(6)}, ${20 + hs(6)})`,    // back rim
        `rgb(${112 + hs(12)}, ${82 + hs(8)}, ${42 + hs(8)})`,  // ramp
        `rgb(${224 + hs(8)}, ${198 + hs(6)}, ${138 + hs(10)})`,// highlight
        `rgb(${158 + hs(12)}, ${122 + hs(8)}, ${64 + hs(10)})`,// body
        `rgb(${96 + hs(10)}, ${72 + hs(6)}, ${36 + hs(8)})`,   // body deep
        `rgb(${42 + hs(8)}, ${30 + hs(6)}, ${16 + hs(6)})`,    // shadow
        `rgb(${42 + hs(8)}, ${30 + hs(6)}, ${16 + hs(6)})`,
        `rgb(${72 + hs(8)}, ${68 + hs(6)}, ${52 + hs(8)})`,    // sky bounce
      ];
    },
    tubeVertGrad: { top: 'rgba(180, 200, 215, 0.10)', bottom: 'rgba(220, 160, 90, 0.18)' },
    tubeSpec: 'rgba(255, 240, 200, 0.55)',
    ridgeAlpha: 0.10,
    patinaColor: 'rgba(56, 78, 64, 0.42)',
    capColors: { center: '#f0d490', mid: '#a48142', rim: '#3e2c14' },
    rimGlow: 'rgba(220, 178, 110, 0.55)',
    innerShadow: { top: '#0c0805', bottom: '#241a0e' },
    title: '風鈴',
    titleFont: '"Noto Serif SC", "Cormorant Garamond", serif',
    titleSize: 36,
    titleLetterSpacing: '0.42em',
    titleOffsetX: 7,
    titleAlpha: 0.5,
    subtitleAlpha: 0.42,
    textColor: { r: 220, g: 230, b: 222 },     // cream for night sky
  },

  // ── CERAMIC — soft dusk, white porcelain with crackle ──────────────────────
  ceramic: {
    id: 'ceramic',
    switchGlyph: 'ج',
    switchFont: '"Noto Naskh Arabic", serif',
    // Warm dusk: peach-pink top → muted lavender → deep dusty rose
    sky: { top: '#3a2a35', mid: '#7a5a5a', bottom: '#c08878' },
    hasMoon: false, hasStars: false, hasMist: true,
    hasClouds: false, hasBambooLeaves: false, hasBirds: true,
    vignetteAlpha: 0.30,
    // Beam stays a wood color but slightly lighter for the brighter sky
    beamColors: { top: '#1c1410', mid: '#352620', bottom: '#1a120e' },
    eyeletColor: '#c8a580',
    // White porcelain with subtle blue-grey shading and a hint of warm rim
    tubeStops: (hue) => {
      const hs = (n: number) => Math.floor(hue * n);
      return [
        `rgb(${178 + hs(6)}, ${172 + hs(6)}, ${168 + hs(6)})`,   // back rim, cool grey
        `rgb(${214 + hs(6)}, ${208 + hs(6)}, ${204 + hs(8)})`,   // ramp
        `rgb(${250 + hs(4)}, ${246 + hs(4)}, ${240 + hs(6)})`,   // bright highlight (almost white)
        `rgb(${235 + hs(8)}, ${228 + hs(6)}, ${220 + hs(8)})`,   // body
        `rgb(${208 + hs(8)}, ${198 + hs(6)}, ${188 + hs(8)})`,   // body shaded
        `rgb(${168 + hs(8)}, ${156 + hs(6)}, ${146 + hs(8)})`,   // shadow side
        `rgb(${168 + hs(8)}, ${156 + hs(6)}, ${146 + hs(8)})`,
        `rgb(${190 + hs(6)}, ${180 + hs(6)}, ${175 + hs(8)})`,   // dusk-pink bounce
      ];
    },
    tubeVertGrad: { top: 'rgba(220, 200, 220, 0.12)', bottom: 'rgba(220, 145, 130, 0.18)' },
    tubeSpec: 'rgba(255, 252, 244, 0.45)',
    ridgeAlpha: 0.04,                  // crackle is more subtle than brass machining
    patinaColor: 'rgba(80, 60, 80, 0.18)',  // very faint blue-grey
    capColors: { center: '#f5ece2', mid: '#d8c0b2', rim: '#8a7068' },
    rimGlow: 'rgba(220, 200, 195, 0.48)',
    innerShadow: { top: '#3a2a2a', bottom: '#5a4848' },
    title: 'الجرس',
    titleFont: '"Noto Naskh Arabic", "Cormorant Garamond", serif',
    titleSize: 42,                      // Arabic baselines run lower; bigger to match optical weight
    titleLetterSpacing: '0',
    titleOffsetX: 0,
    titleAlpha: 0.78,
    subtitleAlpha: 0.62,
    textColor: { r: 60, g: 28, b: 32 },        // deep wine on dusk pink (high-contrast)
  },

  // ── BAMBOO — bright daytime, hollow bamboo segments ────────────────────────
  bamboo: {
    id: 'bamboo',
    switchGlyph: 'घ',
    switchFont: '"Noto Serif Devanagari", serif',
    // Daytime: pale powder blue → cream mid → soft jade-green at the floor
    sky: { top: '#9bb8c8', mid: '#c8d4cc', bottom: '#a8b888' },
    hasMoon: false, hasStars: false, hasMist: false,
    hasClouds: true, hasBambooLeaves: true, hasBirds: false,
    vignetteAlpha: 0.18,                // bright scenes need very light vignetting
    // Beam: warm sun-kissed wood (lighter than the night versions)
    beamColors: { top: '#3a2a1c', mid: '#6a4a30', bottom: '#3a2a1c' },
    eyeletColor: '#c8a560',
    // Bamboo: light yellow-green outer with darker green node lines (handled
    // separately in the render — see bamboo node ridges)
    tubeStops: (hue) => {
      const hs = (n: number) => Math.floor(hue * n);
      return [
        `rgb(${130 + hs(8)}, ${122 + hs(6)}, ${72 + hs(8)})`,    // back rim, dark green-tan
        `rgb(${178 + hs(8)}, ${172 + hs(6)}, ${102 + hs(10)})`,  // ramp
        `rgb(${228 + hs(6)}, ${222 + hs(4)}, ${162 + hs(8)})`,   // highlight (sun-bleached)
        `rgb(${198 + hs(8)}, ${190 + hs(6)}, ${122 + hs(8)})`,   // body
        `rgb(${158 + hs(8)}, ${152 + hs(6)}, ${88 + hs(8)})`,    // body shaded
        `rgb(${102 + hs(8)}, ${96 + hs(6)}, ${56 + hs(8)})`,     // shadow
        `rgb(${102 + hs(8)}, ${96 + hs(6)}, ${56 + hs(8)})`,
        `rgb(${140 + hs(6)}, ${148 + hs(6)}, ${108 + hs(8)})`,   // sky bounce — greenish
      ];
    },
    tubeVertGrad: { top: 'rgba(255, 240, 200, 0.12)', bottom: 'rgba(120, 80, 40, 0.18)' },
    tubeSpec: 'rgba(255, 255, 220, 0.40)',
    ridgeAlpha: 0.18,                   // bamboo nodes are stronger
    patinaColor: 'rgba(60, 80, 40, 0.32)', // green algae specks
    capColors: { center: '#e0c878', mid: '#a08648', rim: '#3c2e10' },
    rimGlow: 'rgba(180, 160, 80, 0.55)',
    innerShadow: { top: '#1a1a08', bottom: '#3a3a18' },
    title: 'घंटी',
    titleFont: '"Noto Serif Devanagari", "Cormorant Garamond", serif',
    titleSize: 38,
    titleLetterSpacing: '0.05em',
    titleOffsetX: 0,
    titleAlpha: 0.78,
    subtitleAlpha: 0.62,
    textColor: { r: 30, g: 50, b: 22 },        // dark forest green on the bright sky
  },
};

const THEME_ORDER: ThemeId[] = ['brass', 'ceramic', 'bamboo'];

// Crossfade duration when switching themes (ms). Currently-decaying audio is
// not interrupted; only the visual rendering is lerped.
const THEME_FADE_MS = 600;

// Linear interpolation between two CSS color strings of form "#rrggbb" or
// "rgb(r,g,b)" or "rgba(r,g,b,a)". Returns "rgba(...)".
function lerpColor(a: string, b: string, t: number): string {
  const pa = parseColor(a), pb = parseColor(b);
  const r = pa[0] + (pb[0] - pa[0]) * t;
  const g = pa[1] + (pb[1] - pa[1]) * t;
  const bl = pa[2] + (pb[2] - pa[2]) * t;
  const al = pa[3] + (pb[3] - pa[3]) * t;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(bl)}, ${al.toFixed(3)})`;
}

// Lerp a boolean-as-weight: returns a value in [0,1] based on fade progress.
// If both ends are the same, returns that constant (no transition flicker).
function lerpW(prev: boolean, curr: boolean, t: number): number {
  const p = prev ? 1 : 0;
  const c = curr ? 1 : 0;
  return p + (c - p) * t;
}

function parseColor(c: string): [number, number, number, number] {
  c = c.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return [r, g, b, 1];
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] === undefined ? 1 : parts[3]];
  }
  return [0, 0, 0, 1];
}

interface Chime {
  anchorX: number;     // px, fixed; computed each frame from canvas size
  anchorY: number;
  L: number;           // tube length, px (visual + pivot length to bottom tip)
  r: number;           // tube radius
  freq: number;
  angle: number;       // current swing angle, rad (0 = straight down)
  angVel: number;      // angular velocity, rad/s
  glow: number;        // 0..1 brightness pulse decaying after a strike
  hueShift: number;    // tiny per-tube color jitter for variety (0..1)
  lastRingMs: number;  // performance.now() of the last ring — used for cooldown
  wasContactingRight: boolean; // edge-trigger: were we touching our right neighbor last frame?
}

interface MistMote {
  x: number; y: number; vx: number; vy: number;
  size: number; alpha: number; phase: number;
}

interface Star {
  x: number; y: number; r: number; baseA: number; phase: number;
}

interface Cloud {
  x: number; y: number; vx: number; w: number; h: number; alpha: number;
}

interface Leaf {           // bamboo leaf silhouette drifting past
  x: number; y: number; vx: number; vy: number; rot: number; rotV: number;
  size: number; alpha: number;
}

interface Bird {           // tiny silhouette gliding across the dusk sky
  x: number; y: number; vx: number; size: number; phase: number; alpha: number;
}

// A real wind chime has a wooden striker (clapper) that hangs below the tubes
// and bumps them on the way through. We model it as a longer, heavier pendulum
// with its own physics — visually it's a small carved disc with a leaf-shaped
// "wind catcher" hanging beneath it.
interface Striker {
  anchorX: number; anchorY: number;
  L: number;          // distance from anchor to disc center
  catcherL: number;   // additional length to the wind-catcher leaf
  angle: number;      // current swing angle, rad
  angVel: number;
  glow: number;
  discR: number;
  catcherW: number;
  catcherH: number;
}

interface Ripple {           // soft ripple at the strike point
  x: number; y: number; t: number; r: number;
  hue: 'jade' | 'brass';
}

export default function WindChime() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 390, h: 844 });
  const dprRef = useRef(1);

  // Chime state — built once, mutated in-place each frame.
  const chimesRef = useRef<Chime[]>([]);
  const strikerRef = useRef<Striker | null>(null);
  const mistRef = useRef<MistMote[]>([]);
  const starsRef = useRef<Star[]>([]);
  const cloudsRef = useRef<Cloud[]>([]);
  const leavesRef = useRef<Leaf[]>([]);
  const birdsRef = useRef<Bird[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);

  // Theme state — `theme` is the *target* (the user's selected theme).
  // `themeRef` and `prevThemeRef` track the in-progress crossfade so the RAF
  // loop can lerp colors between them; React state only changes when a switch
  // is initiated, not every frame.
  const [theme, setTheme] = useState<ThemeId>('brass');
  const themeRef = useRef<ThemeId>('brass');
  const prevThemeRef = useRef<ThemeId>('brass');
  const fadeStartMsRef = useRef<number>(0);   // performance.now() when current fade started; 0 = not fading
  const switchTheme = (next: ThemeId) => {
    if (next === themeRef.current) return;
    prevThemeRef.current = themeRef.current;
    themeRef.current = next;
    fadeStartMsRef.current = performance.now();
    setTheme(next);  // re-render so the switcher highlights correctly
  };
  // Wind = Perlin-ish low-frequency noise used as ambient angular impulse.
  const windRef = useRef({ phase: 0, gust: 0, gustUntil: 0 });
  const lastTimeRef = useRef(performance.now());
  const [hasTouched, setHasTouched] = useState(false);
  const hasTouchedRef = useRef(false);
  // Poster mode (`?poster=1`) renders a static 1024×1024 marketing image:
  // big serif title in the top half, chimes hanging below. Animation pauses
  // (single static frame) and hint text is suppressed.
  const isPoster = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('poster') === '1';

  // Audio — synthesized struck-bell tones. Lazy on first user gesture.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  function ensureAudio() {
    if (!audioCtxRef.current) {
      type WAC = typeof AudioContext;
      const Ctor: WAC | undefined =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: WAC }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.55;
      // Soft master compression-ish lowpass so multiple bells layer well
      master.connect(ctx.destination);
      audioCtxRef.current = ctx;
      masterGainRef.current = master;
    }
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  // Bell synth — fundamental + 2 inharmonic overtones (2.41, 5.43) for a
  // Dispatch to the right synth for the currently active theme. Audio is
  // never crossfaded — a ring uses whichever theme is current at strike time.
  function ringBell(freq: number, vel: number) {
    const ctx = audioCtxRef.current;
    const out = masterGainRef.current;
    if (!ctx || !out || ctx.state !== 'running') return;
    if (themeRef.current === 'ceramic') return ringCeramic(ctx, out, freq, vel);
    if (themeRef.current === 'bamboo')  return ringBamboo(ctx, out, freq, vel);
    return ringBrass(ctx, out, freq, vel);
  }

  // ── Initialize chimes & mist ───────────────────────────────────────────────
  useEffect(() => {
    const initChimes = () => {
      const { w, h } = sizeRef.current;
      const beamY = h * 0.13;
      // Shift the chime cluster slightly RIGHT of center so the moon has
      // its own real estate in the upper-left without crowding the tubes.
      const span = w * 0.66;
      const left = w * 0.22;
      const arr: Chime[] = [];
      for (let i = 0; i < N; i++) {
        const t = N === 1 ? 0.5 : i / (N - 1);
        arr.push({
          anchorX: left + span * t,
          anchorY: beamY + 8,
          L: h * LEN_FRAC[i],
          r: TUBE_R[i],
          freq: FREQS[i],
          angle: 0,
          angVel: 0,
          glow: 0,
          hueShift: (i * 0.137) % 1,
          lastRingMs: 0,
          wasContactingRight: false,
        });
      }
      chimesRef.current = arr;

      // Striker: hangs from the center of the chime cluster, just past the
      // longest tube. It's a wooden disc + leaf-shaped wind catcher — the
      // visual anchor of the composition. The string passes between adjacent
      // chimes (we offset slightly so it doesn't sit right on top of one).
      const longest = Math.max(...arr.map(c => c.L));
      const clusterCx = left + span / 2;
      strikerRef.current = {
        // Offset half a chime spacing so the striker hangs BETWEEN tubes
        anchorX: clusterCx + (span / (N - 1)) * 0.5,
        anchorY: beamY + 8,
        L: longest + 22,
        catcherL: 44,
        angle: 0,
        angVel: 0,
        glow: 0,
        discR: 17,
        catcherW: 28,
        catcherH: 42,
      };
    };
    initChimes();

    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      sizeRef.current = { w, h };
      dprRef.current = dpr;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initChimes();
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    // Mist: 38 slow particles drifting upward + sideways
    const mistArr: MistMote[] = [];
    for (let i = 0; i < 38; i++) {
      mistArr.push({
        x: Math.random() * sizeRef.current.w,
        y: Math.random() * sizeRef.current.h,
        vx: (Math.random() - 0.5) * 0.04,
        vy: -0.05 - Math.random() * 0.06,
        size: 14 + Math.random() * 36,
        alpha: 0.04 + Math.random() * 0.07,
        phase: Math.random() * Math.PI * 2,
      });
    }
    mistRef.current = mistArr;

    // Stars: 24 tiny pinpoints in the upper third, twinkling at different
    // rates. Most are very dim; a handful catch the eye.
    const starArr: Star[] = [];
    for (let i = 0; i < 24; i++) {
      starArr.push({
        x: Math.random() * sizeRef.current.w,
        y: Math.random() * sizeRef.current.h * 0.45,
        r: 0.5 + Math.random() * 0.9,
        baseA: 0.3 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
      });
    }
    starsRef.current = starArr;

    // Clouds: 5 high drifting wisps for the bamboo daytime theme. They exist
    // always (alpha gates them per theme) so a switch fades them in cleanly.
    const cloudArr: Cloud[] = [];
    for (let i = 0; i < 5; i++) {
      cloudArr.push({
        x: Math.random() * sizeRef.current.w,
        y: 30 + Math.random() * sizeRef.current.h * 0.32,
        vx: 0.10 + Math.random() * 0.12,
        w: 80 + Math.random() * 90,
        h: 12 + Math.random() * 8,
        alpha: 0.32 + Math.random() * 0.18,
      });
    }
    cloudsRef.current = cloudArr;

    // Bamboo leaves: 4 silhouettes drifting diagonally — one or two visible
    // at any time, very small, foreground depth (in front of the tubes).
    const leafArr: Leaf[] = [];
    for (let i = 0; i < 4; i++) {
      leafArr.push({
        x: Math.random() * sizeRef.current.w,
        y: Math.random() * sizeRef.current.h * 0.7,
        vx: -0.18 - Math.random() * 0.14,
        vy: 0.10 + Math.random() * 0.06,
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.6,
        size: 12 + Math.random() * 8,
        alpha: 0.55 + Math.random() * 0.25,
      });
    }
    leavesRef.current = leafArr;

    // Birds: 3 silhouettes for the ceramic dusk theme. They cross slowly and
    // wing-flap with `phase`. Wrap when off-screen.
    const birdArr: Bird[] = [];
    for (let i = 0; i < 3; i++) {
      birdArr.push({
        x: Math.random() * sizeRef.current.w,
        y: 60 + Math.random() * sizeRef.current.h * 0.30,
        vx: 0.18 + Math.random() * 0.14,
        size: 5 + Math.random() * 3,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.55 + Math.random() * 0.25,
      });
    }
    birdsRef.current = birdArr;

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── Main RAF loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.045, (now - lastTimeRef.current) / 1000);
      lastTimeRef.current = now;
      const { w, h } = sizeRef.current;
      const chimes = chimesRef.current;

      // ── Wind: slow Perlin-ish noise driving every chime gently ────────────
      const wind = windRef.current;
      wind.phase += dt * 0.18;
      // Occasional gust: ~every 6-12 seconds, lasts 1-2 seconds
      if (now > wind.gustUntil && Math.random() < dt * 0.16) {
        wind.gust = (Math.random() - 0.5) * 0.55;
        wind.gustUntil = now + 900 + Math.random() * 1400;
      }
      if (now > wind.gustUntil) wind.gust *= Math.pow(0.5, dt * 2.2);

      // ── Physics: each chime is a simple pendulum ──────────────────────────
      for (let i = 0; i < chimes.length; i++) {
        const c = chimes[i];
        // Per-chime wind: low-frequency noise so they don't move in lockstep
        const ambient = Math.sin(wind.phase * 1.0 + i * 0.7) * 0.08
                      + Math.sin(wind.phase * 2.3 + i * 1.7) * 0.04;
        const windAccel = (ambient + wind.gust * (0.7 + i * 0.05)) * WIND_FORCE_SCALE;
        const angAcc = -(GRAVITY / c.L) * Math.sin(c.angle)
                     - DAMPING * c.angVel
                     + windAccel;
        c.angVel += angAcc * dt;
        c.angle += c.angVel * dt;
        // Hard clamp on extreme swing — beyond this, the small-angle
        // collision resolution stops working and tubes can stack up.
        if (c.angle > MAX_ANGLE) { c.angle = MAX_ANGLE; if (c.angVel > 0) c.angVel = 0; }
        if (c.angle < -MAX_ANGLE) { c.angle = -MAX_ANGLE; if (c.angVel < 0) c.angVel = 0; }
        // Glow comes from tilt — the polished cylinder catches moonlight
        // when its face turns toward the light. Quadratic ramp past a small
        // threshold so resting tubes are matte. Brass only — ceramic/bamboo
        // are matte materials and shouldn't fluoresce on swing.
        if (themeRef.current === 'brass' || prevThemeRef.current === 'brass') {
          const ang = Math.abs(c.angle);
          if (ang < GLOW_THRESHOLD) {
            c.glow = 0;
          } else {
            const k = (ang - GLOW_THRESHOLD) / (MAX_ANGLE - GLOW_THRESHOLD);
            c.glow = Math.min(1, k * k * GLOW_GAIN);
          }
        } else {
          c.glow = 0;
        }
      }

      // Striker pendulum — same model, but longer + heavier so it swings
      // slowly. The wind acts more strongly on it (catcher leaf has surface).
      const striker = strikerRef.current;
      if (striker) {
        const sAmbient = Math.sin(wind.phase * 0.7 + 4.2) * 0.12
                       + Math.sin(wind.phase * 1.6 + 2.1) * 0.05;
        const sWind = (sAmbient + wind.gust * 1.1) * STRIKER_WIND_SCALE;
        const sAcc = -(GRAVITY / striker.L) * Math.sin(striker.angle)
                   - DAMPING * 0.7 * striker.angVel
                   + sWind;
        striker.angVel += sAcc * dt;
        striker.angle += striker.angVel * dt;
        striker.glow = Math.max(0, striker.glow - dt * 1.4);
      }

      // ── Collisions between adjacent tubes ─────────────────────────────────
      // Pass 0: detect contacts, resolve position + velocity, ring on edge.
      // Pass 1: re-resolve any positions still overlapping (only — no extra
      // velocity changes or rings). Without pass 1, a hard hit can leave the
      // row ripple-clustered.
      // After both passes, we update the per-chime "contacting right neighbor"
      // flag based on the FINAL post-resolution state, so the next frame's
      // edge-trigger fires correctly.
      const finalContact = new Array<boolean>(chimes.length).fill(false);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < chimes.length - 1; i++) {
          const a = chimes[i], b = chimes[i + 1];
          const ax = a.anchorX + a.L * Math.sin(a.angle);
          const bx = b.anchorX + b.L * Math.sin(b.angle);
          const minDist = a.r + b.r + COLLISION_GAP;
          if (bx - ax >= minDist) continue;
          // Resolve overlap — heavier (longer) tube moves less (inv-mass = 1/L)
          const overlap = minDist - (bx - ax);
          const invA = 1 / a.L, invB = 1 / b.L;
          const sumInv = invA + invB;
          a.angle -= (overlap * invA / sumInv) / a.L;
          b.angle += (overlap * invB / sumInv) / b.L;

          if (pass === 0) {
            // Velocity response — only resolve closing motion. If they're
            // already separating (e.g. mid-bounce), leave velocities alone.
            const va = a.angVel * a.L, vb = b.angVel * b.L;
            const closing = va - vb;  // > 0 means approaching
            if (closing > 0) {
              // Equal-mass 1D elastic bounce, scaled by restitution
              const j = closing * (1 + COLLIDE_RESTITUTION) * 0.5;
              a.angVel = (va - j) / a.L;
              b.angVel = (vb + j) / b.L;
              // Edge-trigger ring: only on the first frame of contact, and
              // only if both chimes are off cooldown.
              if (!a.wasContactingRight && closing > RING_VEL_THRESHOLD) {
                const vel = Math.min(1, closing * 0.35);
                if (now - a.lastRingMs > RING_COOLDOWN_MS) {
                  ringBell(a.freq, vel * 0.85);
                  a.lastRingMs = now;
                }
                if (now - b.lastRingMs > RING_COOLDOWN_MS) {
                  ringBell(b.freq, vel * 0.85);
                  b.lastRingMs = now;
                }
                const rx = (ax + bx) / 2;
                const ry = a.anchorY + Math.min(a.L, b.L) * Math.cos(a.angle) * 0.85;
                ripplesRef.current.push({ x: rx, y: ry, t: 0, r: 22, hue: 'brass' });
              }
            }
          }
          finalContact[i] = true;
        }
      }
      // Update the edge-trigger memory for next frame
      for (let i = 0; i < chimes.length; i++) {
        chimes[i].wasContactingRight = finalContact[i];
      }

      // ── Mist drift ────────────────────────────────────────────────────────
      for (const m of mistRef.current) {
        m.x += m.vx;
        m.y += m.vy;
        m.phase += dt * 0.6;
        if (m.y < -60) { m.y = h + 30; m.x = Math.random() * w; }
        if (m.x < -60) m.x = w + 30;
        if (m.x > w + 60) m.x = -30;
      }

      // ── Render ────────────────────────────────────────────────────────────
      // Compute the active theme blend for this frame.
      const fadeStart = fadeStartMsRef.current;
      const fadeT = fadeStart === 0 ? 1 : Math.min(1, (now - fadeStart) / THEME_FADE_MS);
      if (fadeT >= 1 && fadeStart !== 0) fadeStartMsRef.current = 0;
      const themeCurr = THEMES[themeRef.current];
      const themePrev = THEMES[prevThemeRef.current];
      // Per-feature visibility weights — boolean flags lerp 0..1 across the fade
      const w_moon  = lerpW(themePrev.hasMoon, themeCurr.hasMoon, fadeT);
      const w_stars = lerpW(themePrev.hasStars, themeCurr.hasStars, fadeT);
      const w_mist  = lerpW(themePrev.hasMist, themeCurr.hasMist, fadeT);
      const w_clouds = lerpW(themePrev.hasClouds, themeCurr.hasClouds, fadeT);
      const w_leaves = lerpW(themePrev.hasBambooLeaves, themeCurr.hasBambooLeaves, fadeT);
      const w_birds  = lerpW(themePrev.hasBirds, themeCurr.hasBirds, fadeT);
      // Lerped colors for the sky/beam/eyelet
      const c = (a: string, b: string) => fadeT >= 1 ? b : lerpColor(a, b, fadeT);
      const skyTop = c(themePrev.sky.top, themeCurr.sky.top);
      const skyMid = c(themePrev.sky.mid, themeCurr.sky.mid);
      const skyBot = c(themePrev.sky.bottom, themeCurr.sky.bottom);
      const vignA  = themePrev.vignetteAlpha + (themeCurr.vignetteAlpha - themePrev.vignetteAlpha) * fadeT;

      // Sky gradient
      const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
      skyGrad.addColorStop(0, skyTop);
      skyGrad.addColorStop(0.55, skyMid);
      skyGrad.addColorStop(1, skyBot);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, h);

      // Stars (gated by w_stars)
      if (w_stars > 0.01) {
        const stars = starsRef.current;
        for (const s of stars) {
          const a = s.baseA * (0.55 + 0.45 * Math.sin(now * 0.001 + s.phase));
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(218, 226, 218, ${a * 0.65 * w_stars})`;
          ctx.fill();
        }
      }

      // Clouds (bamboo daytime — drift left-to-right slowly)
      if (w_clouds > 0.01) {
        const clouds = cloudsRef.current;
        for (const cl of clouds) {
          cl.x += cl.vx;
          if (cl.x - cl.w > w) cl.x = -cl.w;
          // Soft elliptical wisp — long horizontal radial gradient
          const grad = ctx.createRadialGradient(cl.x, cl.y, 0, cl.x, cl.y, cl.w * 0.5);
          grad.addColorStop(0, `rgba(252, 248, 240, ${cl.alpha * w_clouds})`);
          grad.addColorStop(0.6, `rgba(248, 240, 230, ${cl.alpha * 0.4 * w_clouds})`);
          grad.addColorStop(1, 'rgba(248, 240, 230, 0)');
          ctx.save();
          ctx.translate(cl.x, cl.y);
          ctx.scale(1, cl.h / cl.w * 2);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(0, 0, cl.w * 0.5, 0, Math.PI * 2);
          ctx.translate(-cl.x, -cl.y);
          ctx.fill();
          ctx.restore();
        }
      }

      // Birds (ceramic dusk — small silhouettes flying)
      if (w_birds > 0.01) {
        const birds = birdsRef.current;
        ctx.fillStyle = `rgba(58, 38, 32, ${0.62 * w_birds})`;
        for (const bd of birds) {
          bd.x += bd.vx;
          bd.phase += dt * 4;
          if (bd.x - 20 > w) { bd.x = -20; bd.y = 60 + Math.random() * h * 0.3; }
          // Wings as two small arcs that flap with phase — a rough "M" shape
          const flap = Math.sin(bd.phase) * bd.size * 0.5;
          ctx.beginPath();
          ctx.moveTo(bd.x - bd.size * 1.2, bd.y);
          ctx.quadraticCurveTo(bd.x - bd.size * 0.6, bd.y - flap - 1, bd.x, bd.y);
          ctx.quadraticCurveTo(bd.x + bd.size * 0.6, bd.y - flap - 1, bd.x + bd.size * 1.2, bd.y);
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = `rgba(58, 38, 32, ${0.62 * w_birds})`;
          ctx.stroke();
        }
      }

      // ── Moon (gated by w_moon) ────────────────────────────────────────────
      if (w_moon > 0.01) {
        const moonX = w * 0.19, moonY = h * 0.165;
        const moonDiscR = 24;
        const M = w_moon;
        const farHalo = ctx.createRadialGradient(moonX, moonY, moonDiscR * 0.5, moonX, moonY, h * 0.55);
        farHalo.addColorStop(0, `rgba(232, 226, 200, ${0.18 * M})`);
        farHalo.addColorStop(0.25, `rgba(200, 210, 198, ${0.07 * M})`);
        farHalo.addColorStop(0.6, `rgba(170, 188, 188, ${0.03 * M})`);
        farHalo.addColorStop(1, 'rgba(170, 188, 188, 0)');
        ctx.fillStyle = farHalo;
        ctx.fillRect(0, 0, w, h);
        const closeHaze = ctx.createRadialGradient(moonX, moonY, moonDiscR * 0.85, moonX, moonY, moonDiscR * 3.2);
        closeHaze.addColorStop(0, `rgba(245, 234, 198, ${0.32 * M})`);
        closeHaze.addColorStop(0.4, `rgba(220, 218, 198, ${0.10 * M})`);
        closeHaze.addColorStop(1, 'rgba(220, 218, 198, 0)');
        ctx.fillStyle = closeHaze;
        ctx.fillRect(0, 0, w, h);
        const disc = ctx.createRadialGradient(moonX - 6, moonY - 7, 0.5, moonX, moonY, moonDiscR);
        disc.addColorStop(0, `rgba(252, 245, 218, ${0.98 * M})`);
        disc.addColorStop(0.5, `rgba(232, 222, 188, ${0.93 * M})`);
        disc.addColorStop(0.85, `rgba(196, 192, 168, ${0.78 * M})`);
        disc.addColorStop(1, 'rgba(170, 174, 158, 0)');
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonDiscR, 0, Math.PI * 2);
        ctx.fillStyle = disc;
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonDiscR - 0.5, 0, Math.PI * 2);
        ctx.clip();
        const maria: Array<[number, number, number, number]> = [
          [-3, 1, 8, 0.18], [4, -2, 5.5, 0.14], [-1, 5, 4, 0.12],
        ];
        for (const [dx, dy, mr, ma] of maria) {
          const mg = ctx.createRadialGradient(moonX + dx, moonY + dy, 0, moonX + dx, moonY + dy, mr);
          mg.addColorStop(0, `rgba(150, 145, 128, ${ma * M})`);
          mg.addColorStop(1, 'rgba(150, 145, 128, 0)');
          ctx.fillStyle = mg;
          ctx.fillRect(moonX - moonDiscR, moonY - moonDiscR, moonDiscR * 2, moonDiscR * 2);
        }
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonDiscR - 0.6, 0, Math.PI * 2);
        ctx.clip();
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonDiscR + 0.4, Math.PI * 0.95, Math.PI * 1.75);
        ctx.strokeStyle = `rgba(255, 246, 220, ${0.7 * M})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
        const outerGlow = ctx.createRadialGradient(moonX, moonY, moonDiscR, moonX, moonY, moonDiscR + 12);
        outerGlow.addColorStop(0, `rgba(255, 245, 215, ${0.18 * M})`);
        outerGlow.addColorStop(1, 'rgba(255, 245, 215, 0)');
        ctx.fillStyle = outerGlow;
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonDiscR + 12, 0, Math.PI * 2);
        ctx.fill();
      }

      // Mist (gated by w_mist; tinted toward the active sky)
      if (w_mist > 0.01) {
        const mistTint = c('rgba(200, 215, 210, 1)', 'rgba(200, 215, 210, 1)');
        for (const m of mistRef.current) {
          const a = m.alpha * (0.7 + Math.sin(m.phase) * 0.25) * w_mist;
          const grad = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size);
          // Apply alpha to the parsed mist tint color
          const baseTint = parseColor(mistTint);
          grad.addColorStop(0, `rgba(${baseTint[0]}, ${baseTint[1]}, ${baseTint[2]}, ${a})`);
          grad.addColorStop(1, `rgba(${baseTint[0]}, ${baseTint[1]}, ${baseTint[2]}, 0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(m.x - m.size, m.y - m.size, m.size * 2, m.size * 2);
        }
      }

      // Vignette
      const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 0.85);
      vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vg.addColorStop(1, `rgba(0, 0, 0, ${vignA})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // ── Title (theme-specific script + crossfade between scripts) ────────
      drawThemeTitle(ctx, w, h, themePrev, themeCurr, fadeT, hasTouchedRef.current || isPoster);

      // ── Beam (the wood that holds the chimes) ─────────────────────────────
      const beamY = h * 0.13;
      const beamH = 14;
      const beamGrad = ctx.createLinearGradient(0, beamY, 0, beamY + beamH);
      beamGrad.addColorStop(0, c(themePrev.beamColors.top, themeCurr.beamColors.top));
      beamGrad.addColorStop(0.5, c(themePrev.beamColors.mid, themeCurr.beamColors.mid));
      beamGrad.addColorStop(1, c(themePrev.beamColors.bottom, themeCurr.beamColors.bottom));
      ctx.fillStyle = beamGrad;
      ctx.fillRect(0, beamY, w, beamH);
      // Beam top highlight (faint)
      ctx.fillStyle = 'rgba(180, 162, 120, 0.08)';
      ctx.fillRect(0, beamY, w, 1);
      // Beam bottom shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, beamY + beamH, w, 6);

      // Eyelets where strings meet beam (brass / dark / dark — colored per theme)
      const eyeletCol = c(themePrev.eyeletColor, themeCurr.eyeletColor);
      for (const ch of chimes) {
        ctx.beginPath();
        ctx.arc(ch.anchorX, beamY + beamH - 1, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = eyeletCol;
        ctx.fill();
      }

      // ── Strings + tubes ───────────────────────────────────────────────────
      for (let i = 0; i < chimes.length; i++) {
        drawChime(ctx, chimes[i], themePrev, themeCurr, fadeT);
      }

      // Bamboo leaves (drawn in front of tubes for foreground depth)
      if (w_leaves > 0.01) {
        const leaves = leavesRef.current;
        for (const lf of leaves) {
          lf.x += lf.vx;
          lf.y += lf.vy;
          lf.rot += lf.rotV * dt;
          if (lf.x < -40) { lf.x = w + 30; lf.y = -20 + Math.random() * h * 0.4; }
          if (lf.y > h + 30) { lf.y = -20; lf.x = Math.random() * w; }
          ctx.save();
          ctx.translate(lf.x, lf.y);
          ctx.rotate(lf.rot);
          // Leaf — almond shape, deep green
          ctx.beginPath();
          const sz = lf.size;
          ctx.moveTo(0, -sz);
          ctx.bezierCurveTo(sz * 0.45, -sz * 0.5, sz * 0.45, sz * 0.5, 0, sz);
          ctx.bezierCurveTo(-sz * 0.45, sz * 0.5, -sz * 0.45, -sz * 0.5, 0, -sz);
          ctx.fillStyle = `rgba(38, 58, 28, ${lf.alpha * w_leaves})`;
          ctx.fill();
          // Leaf vein
          ctx.beginPath();
          ctx.moveTo(0, -sz);
          ctx.lineTo(0, sz);
          ctx.strokeStyle = `rgba(110, 140, 80, ${lf.alpha * 0.5 * w_leaves})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
          ctx.restore();
        }
      }

      // ── Striker (drawn AFTER chimes so it sits in front) ──────────────────
      if (striker) drawStriker(ctx, striker);

      // ── Ripples (soft jade rings on contact points) ───────────────────────
      const ripples = ripplesRef.current;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.t += dt;
        const lifespan = 0.9;
        if (rp.t > lifespan) { ripples.splice(i, 1); continue; }
        const k = rp.t / lifespan;
        const r = rp.r + k * 38;
        const alpha = (1 - k) * 0.4;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = rp.hue === 'brass'
          ? `rgba(196, 170, 110, ${alpha})`
          : `rgba(160, 198, 188, ${alpha})`;
        ctx.lineWidth = 1.4 * (1 - k * 0.5);
        ctx.stroke();
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pointer interaction ────────────────────────────────────────────────────
  // Tap on a tube → impulse the chime + ring it.
  // Tap on empty area → spawn a small wind gust.
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    ensureAudio();
    if (!hasTouchedRef.current) { setHasTouched(true); hasTouchedRef.current = true; }
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const chimes = chimesRef.current;
    let hit: Chime | null = null;
    let hitDist = Infinity;
    for (const c of chimes) {
      // Compute tube line endpoints
      const sin = Math.sin(c.angle), cos = Math.cos(c.angle);
      const x1 = c.anchorX, y1 = c.anchorY;
      const x2 = c.anchorX + c.L * sin;
      const y2 = c.anchorY + c.L * cos;
      // Distance from (x,y) to segment (x1,y1)-(x2,y2)
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const tParam = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const px = x1 + tParam * dx, py = y1 + tParam * dy;
      const d = Math.hypot(x - px, y - py);
      // Generous hit area: tube radius + 12px
      if (d < c.r + 12 && d < hitDist) { hit = c; hitDist = d; }
    }
    if (hit) {
      // Direction of impulse: away from the side they were tapped
      const tipX = hit.anchorX + hit.L * Math.sin(hit.angle);
      const sign = x < tipX ? +1 : -1;
      hit.angVel += sign * TAP_IMPULSE;
      hit.angVel = Math.max(-2.6, Math.min(2.6, hit.angVel));
      // glow is no longer driven by tap — it now follows angle in the physics
      // loop, so the natural swing creates the glint at peak tilt
      ringBell(hit.freq, 0.85);
      ripplesRef.current.push({ x, y, t: 0, r: 18, hue: 'jade' });
      return;
    }
    // Try the striker — generous hit area around the disc + catcher
    const s = strikerRef.current;
    if (s) {
      const sin = Math.sin(s.angle), cos = Math.cos(s.angle);
      const dx = s.anchorX + s.L * sin;
      const dy = s.anchorY + s.L * cos;
      const cx = dx + s.catcherL * sin;
      const cy = dy + s.catcherL * cos;
      // Distance to disc OR catcher, whichever closer
      const dDisc = Math.hypot(x - dx, y - dy);
      const dCatch = Math.hypot(x - cx, y - cy);
      if (dDisc < s.discR + 16 || dCatch < Math.max(s.catcherW, s.catcherH) * 0.6) {
        const sign = x < dx ? +1 : -1;
        s.angVel += sign * 0.85;
        s.angVel = Math.max(-1.8, Math.min(1.8, s.angVel));
        s.glow = 1;
        // Striker doesn't ring — it's wood. A muffled low tone instead.
        playKnock();
        ripplesRef.current.push({ x: dx, y: dy, t: 0, r: 18, hue: 'brass' });
        return;
      }
    }
    // Empty tap → soft wind gust
    windRef.current.gust = (x < sizeRef.current.w / 2 ? 1 : -1) * 0.45;
    windRef.current.gustUntil = performance.now() + 900;
    ripplesRef.current.push({ x, y, t: 0, r: 14, hue: 'jade' });
  };

  // Wood knock — short low filtered noise envelope. Used when the striker
  // disc itself is tapped (wood, not metal).
  function playKnock() {
    const ctx = audioCtxRef.current;
    const out = masterGainRef.current;
    if (!ctx || !out || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const dur = 0.18;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      const t = i / ch.length;
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 4);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.45;
    noise.connect(lp).connect(g).connect(out);
    noise.start(now);
    // Tiny tone underneath
    const osc = ctx.createOscillator();
    osc.frequency.value = 92;
    osc.type = 'sine';
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, now);
    og.gain.linearRampToValueAtTime(0.18, now + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(og).connect(out);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  return (
    <div className="wc">
      <canvas
        ref={canvasRef}
        className="wc__canvas"
        onPointerDown={onPointerDown}
      />
      {!isPoster && (() => {
        const tc = THEMES[theme].textColor;
        const dotColor = `rgba(${tc.r}, ${tc.g}, ${tc.b}, 0.78)`;
        return (
          <div className="wc__switcher">
            {THEME_ORDER.map(id => {
              const cfg = THEMES[id];
              const isActive = theme === id;
              const color = isActive
                ? `rgba(${tc.r}, ${tc.g}, ${tc.b}, 0.92)`
                : `rgba(${tc.r}, ${tc.g}, ${tc.b}, 0.36)`;
              return (
                <button
                  key={id}
                  className={`wc__sw ${isActive ? 'wc__sw--active' : ''}`}
                  onPointerDown={(e) => { e.stopPropagation(); ensureAudio(); switchTheme(id); }}
                  aria-label={cfg.id}
                  style={{
                    fontFamily: cfg.switchFont,
                    color,
                    ['--wc-dot' as string]: dotColor,
                  }}
                >
                  <span className="wc__sw-glyph">{cfg.switchGlyph}</span>
                </button>
              );
            })}
          </div>
        );
      })()}
      {!hasTouched && !isPoster && (
        <div className="wc__hint">tap a chime · breathe</div>
      )}
      {!isPoster && <div className="wc__brand">courtyard study</div>}
    </div>
  );
}

// ── Audio synths per theme ───────────────────────────────────────────────────
// Brass: 3 inharmonic sine partials (1.0, 2.41, 5.43) with long exp decay,
// plus a high-pass filtered noise tick on attack (mallet contact).
function ringBrass(ctx: AudioContext, out: AudioNode, freq: number, vel: number) {
  const v = Math.max(0.05, Math.min(1, vel));
  const now = ctx.currentTime;
  const PARTIALS = [
    { ratio: 1.0, gain: 0.55, decay: 4.2 },
    { ratio: 2.41, gain: 0.22 * (0.4 + v * 0.6), decay: 2.4 },
    { ratio: 5.43, gain: 0.10 * (0.3 + v * 0.7), decay: 1.4 },
  ];
  const bus = ctx.createGain();
  bus.gain.value = 0.4 + v * 0.6;
  bus.connect(out);
  for (const p of PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * p.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(p.gain, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
    osc.connect(g).connect(bus);
    osc.start(now);
    osc.stop(now + p.decay + 0.05);
  }
  // Mallet-contact noise tick
  const noiseDur = 0.06;
  const buf = ctx.createBuffer(1, ctx.sampleRate * noiseDur, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const ng = ctx.createGain();
  ng.gain.value = 0.04 * v;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  noise.connect(hp).connect(ng).connect(bus);
  noise.start(now);
}

// Ceramic: short single-pitch sine + small near-harmonic for "tink" character,
// with a sharp attack click. Decay ~0.8s. No prolonged metallic tail.
function ringCeramic(ctx: AudioContext, out: AudioNode, freq: number, vel: number) {
  const v = Math.max(0.05, Math.min(1, vel));
  const now = ctx.currentTime;
  const bus = ctx.createGain();
  bus.gain.value = 0.42 + v * 0.55;
  bus.connect(out);
  // Fundamental + slight 3.0x partial (close to harmonic — porcelain rings
  // mostly at fundamental with a glassy upper sparkle)
  const fundamentalDecay = 0.85;
  const upperDecay = 0.32;
  const fund = ctx.createOscillator();
  fund.type = 'sine';
  fund.frequency.value = freq * 1.005;       // tiny detune for warmth
  const fg = ctx.createGain();
  fg.gain.setValueAtTime(0, now);
  fg.gain.linearRampToValueAtTime(0.62, now + 0.003);
  fg.gain.exponentialRampToValueAtTime(0.0001, now + fundamentalDecay);
  fund.connect(fg).connect(bus);
  fund.start(now); fund.stop(now + fundamentalDecay + 0.05);
  const upper = ctx.createOscillator();
  upper.type = 'sine';
  upper.frequency.value = freq * 3.02;
  const ug = ctx.createGain();
  ug.gain.setValueAtTime(0, now);
  ug.gain.linearRampToValueAtTime(0.18 * v, now + 0.003);
  ug.gain.exponentialRampToValueAtTime(0.0001, now + upperDecay);
  upper.connect(ug).connect(bus);
  upper.start(now); upper.stop(now + upperDecay + 0.05);
  // Sharp attack click — band-passed noise burst
  const noiseDur = 0.04;
  const buf = ctx.createBuffer(1, ctx.sampleRate * noiseDur, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq * 4;
  bp.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.value = 0.18 * v;
  noise.connect(bp).connect(ng).connect(bus);
  noise.start(now);
}

// Bamboo: hollow wood resonance — fundamental sine with mild 2nd harmonic and
// a gentle low-pass attack. Decay ~1.5s. Like a Japanese suikinkutsu drop.
function ringBamboo(ctx: AudioContext, out: AudioNode, freq: number, vel: number) {
  const v = Math.max(0.05, Math.min(1, vel));
  const now = ctx.currentTime;
  const bus = ctx.createGain();
  bus.gain.value = 0.50 + v * 0.45;
  // Soft low-pass filter on the bus shapes the wood timbre
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = freq * 6;
  lp.Q.value = 0.8;
  bus.connect(lp).connect(out);
  // Fundamental — gentler attack than brass
  const fund = ctx.createOscillator();
  fund.type = 'sine';
  fund.frequency.value = freq * 0.998;
  const fg = ctx.createGain();
  fg.gain.setValueAtTime(0, now);
  fg.gain.linearRampToValueAtTime(0.55, now + 0.012);
  fg.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
  fund.connect(fg).connect(bus);
  fund.start(now); fund.stop(now + 1.65);
  // 2nd harmonic — dampens the metallic edge, adds woody body
  const second = ctx.createOscillator();
  second.type = 'sine';
  second.frequency.value = freq * 2.005;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0, now);
  sg.gain.linearRampToValueAtTime(0.18 * v, now + 0.012);
  sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
  second.connect(sg).connect(bus);
  second.start(now); second.stop(now + 0.85);
  // Soft thump on attack — a low filtered noise burst (the "ko" sound)
  const thumpDur = 0.10;
  const buf = ctx.createBuffer(1, ctx.sampleRate * thumpDur, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const lp2 = ctx.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.value = freq * 1.5;
  const ng = ctx.createGain();
  ng.gain.value = 0.10 * v;
  noise.connect(lp2).connect(ng).connect(bus);
  noise.start(now);
}

// ── Title rendering — theme-driven exotic script with optional crossfade ─────
// During a theme switch we render the OLD title fading out + the NEW title
// fading in at the same position. Letter-spacing and optical centering are
// per-theme since each script behaves differently.
function drawThemeTitle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  themePrev: ThemeConfig,
  themeCurr: ThemeConfig,
  fadeT: number,
  hasTouched: boolean,
) {
  const cx = w / 2;
  const cy = h * 0.83;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const drawOne = (theme: ThemeConfig, alphaScale: number) => {
    if (alphaScale < 0.01) return;
    const tc = theme.textColor;
    ctx.font = `300 ${theme.titleSize}px ${theme.titleFont}`;
    ctx2dLetterSpacing(ctx, theme.titleLetterSpacing);
    // Soft drop-glow (slightly darker variant of textColor for depth)
    ctx.fillStyle = `rgba(${tc.r}, ${tc.g}, ${tc.b}, ${0.18 * alphaScale})`;
    ctx.fillText(theme.title, cx + theme.titleOffsetX, cy + 1);
    // Main fill
    ctx.fillStyle = `rgba(${tc.r}, ${tc.g}, ${tc.b}, ${theme.titleAlpha * alphaScale})`;
    ctx.fillText(theme.title, cx + theme.titleOffsetX, cy);
  };

  if (fadeT < 1 && themePrev.id !== themeCurr.id) {
    drawOne(themePrev, 1 - fadeT);
    drawOne(themeCurr, fadeT);
  } else {
    drawOne(themeCurr, 1);
  }

  // Latin subtitle — color lerps between themes during the fade
  const tcCurr = themeCurr.textColor;
  const tcPrev = themePrev.textColor;
  const subR = Math.round(tcPrev.r + (tcCurr.r - tcPrev.r) * fadeT);
  const subG = Math.round(tcPrev.g + (tcCurr.g - tcPrev.g) * fadeT);
  const subB = Math.round(tcPrev.b + (tcCurr.b - tcPrev.b) * fadeT);
  const subA = themePrev.subtitleAlpha + (themeCurr.subtitleAlpha - themePrev.subtitleAlpha) * fadeT;
  ctx2dLetterSpacing(ctx, '0.34em');
  ctx.font = '300 italic 11px "Cormorant Garamond", serif';
  ctx.fillStyle = `rgba(${subR}, ${subG}, ${subB}, ${subA})`;
  ctx.fillText('wind chime', cx + 1.5, cy + 32);

  if (!hasTouched) {
    ctx2dLetterSpacing(ctx, '0.32em');
    ctx.font = '300 9px "JetBrains Mono", ui-monospace, monospace';
    const breath = 0.45 + Math.sin(performance.now() * 0.0022) * 0.22;
    ctx.fillStyle = `rgba(${subR}, ${subG}, ${subB}, ${breath * 0.65})`;
    ctx.fillText('TAP A TUBE · BREATHE', cx + 4, cy + 60);
  }
  ctx.restore();
}

// ── Tube rendering ───────────────────────────────────────────────────────────
function drawChime(
  ctx: CanvasRenderingContext2D,
  c: Chime,
  themePrev: ThemeConfig,
  themeCurr: ThemeConfig,
  fadeT: number,
) {
  const sin = Math.sin(c.angle), cos = Math.cos(c.angle);
  const x1 = c.anchorX, y1 = c.anchorY;
  const x2 = x1 + c.L * sin;
  const y2 = y1 + c.L * cos;

  // Compute the active material — lerp every theme color across the fade.
  const lerp = (a: string, b: string) => fadeT >= 1 ? b : lerpColor(a, b, fadeT);
  const stopsPrev = themePrev.tubeStops(c.hueShift);
  const stopsCurr = themeCurr.tubeStops(c.hueShift);
  const stops = stopsPrev.map((s, i) => lerp(s, stopsCurr[i]));
  const vTop = lerp(themePrev.tubeVertGrad.top, themeCurr.tubeVertGrad.top);
  const vBot = lerp(themePrev.tubeVertGrad.bottom, themeCurr.tubeVertGrad.bottom);
  const specC = lerp(themePrev.tubeSpec, themeCurr.tubeSpec);
  const ridgeAlpha = themePrev.ridgeAlpha + (themeCurr.ridgeAlpha - themePrev.ridgeAlpha) * fadeT;
  const patina = lerp(themePrev.patinaColor, themeCurr.patinaColor);
  const capCenter = lerp(themePrev.capColors.center, themeCurr.capColors.center);
  const capMid    = lerp(themePrev.capColors.mid,    themeCurr.capColors.mid);
  const capRim    = lerp(themePrev.capColors.rim,    themeCurr.capColors.rim);
  const rimGlow   = lerp(themePrev.rimGlow, themeCurr.rimGlow);
  const innerTop  = lerp(themePrev.innerShadow.top,    themeCurr.innerShadow.top);
  const innerBot  = lerp(themePrev.innerShadow.bottom, themeCurr.innerShadow.bottom);
  // Bamboo gets explicit dark node bands at fixed intervals along the tube
  const bambooWeight = (themePrev.id === 'bamboo' ? 1 : 0) * (1 - fadeT)
                     + (themeCurr.id === 'bamboo' ? 1 : 0) * fadeT;

  // Thread/string from beam down to tube top — a fine charcoal line
  ctx.beginPath();
  ctx.moveTo(x1, y1 - 4);
  ctx.lineTo(x1 + 8 * sin, y1 + 8 * cos);
  ctx.strokeStyle = 'rgba(20, 14, 8, 0.85)';
  ctx.lineWidth = 0.9;
  ctx.stroke();

  // Tube body — translate to tube center, rotate, draw vertical capsule
  const tubeAngle = Math.atan2(y2 - y1, x2 - x1);
  const cxt = (x1 + x2) / 2;
  const cyt = (y1 + y2) / 2;
  const tubeLen = c.L * 0.96;     // leave a hair near the top fastening
  const r = c.r;

  ctx.save();
  ctx.translate(cxt, cyt);
  ctx.rotate(tubeAngle - Math.PI / 2);

  // Drop shadow on background (soft, behind tube)
  ctx.save();
  ctx.translate(2.5, 2);
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.filter = 'blur(2.5px)';
  ctx.fill();
  ctx.restore();

  // Cylindrical body — eight-stop horizontal gradient simulating a polished
  // cylinder under upper-left key light. Stops are theme-driven (brass / white
  // porcelain / bamboo) and lerped across theme transitions.
  const hue = c.hueShift;
  const grad = ctx.createLinearGradient(-r, 0, r, 0);
  const stopsPos = [0.00, 0.10, 0.28, 0.42, 0.65, 0.88, 0.97, 1.00];
  for (let i = 0; i < 8; i++) grad.addColorStop(stopsPos[i], stops[i]);
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.fillStyle = grad;
  ctx.fill();

  // Vertical shading — sky tint at top, warm bounce at bottom (theme-tinted)
  const vert = ctx.createLinearGradient(0, -tubeLen / 2, 0, tubeLen / 2);
  vert.addColorStop(0, vTop);
  vert.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  vert.addColorStop(0.85, 'rgba(0, 0, 0, 0)');
  vert.addColorStop(1, vBot);
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.fillStyle = vert;
  ctx.fill();

  // Lathe / crackle / node ridges (theme-dependent)
  ctx.save();
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.clip();
  ctx.strokeStyle = `rgba(0, 0, 0, ${ridgeAlpha})`;
  ctx.lineWidth = 0.5;
  const ridgeStep = 7 + hue * 2;
  for (let y = -tubeLen / 2 + 4; y < tubeLen / 2 - 4; y += ridgeStep) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.95, y);
    ctx.lineTo(r * 0.95, y);
    ctx.stroke();
  }
  // Bamboo nodes — strong dark bands every ~1/4 of the tube length, with a
  // subtle highlight ring above each band. Only visible during bamboo theme.
  if (bambooWeight > 0.01) {
    const nodeGap = tubeLen / 3.5;
    ctx.lineWidth = 1.6;
    for (let y = -tubeLen / 2 + nodeGap; y < tubeLen / 2 - 4; y += nodeGap) {
      ctx.strokeStyle = `rgba(40, 50, 18, ${0.55 * bambooWeight})`;
      ctx.beginPath();
      ctx.moveTo(-r, y);
      ctx.lineTo(r, y);
      ctx.stroke();
      // Highlight ridge above the node
      ctx.strokeStyle = `rgba(220, 210, 140, ${0.32 * bambooWeight})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-r * 0.95, y - 2);
      ctx.lineTo(r * 0.95, y - 2);
      ctx.stroke();
      ctx.lineWidth = 1.6;
    }
  }
  // Faint warm specular line at left highlight (very thin, very bright)
  const specBase = parseColor(specC);
  const specGrad = ctx.createLinearGradient(0, -tubeLen / 2, 0, tubeLen / 2);
  const sR = specBase[0], sG = specBase[1], sB = specBase[2], sA = specBase[3];
  specGrad.addColorStop(0.00, `rgba(${sR}, ${sG}, ${sB}, 0)`);
  specGrad.addColorStop(0.10, `rgba(${sR}, ${sG}, ${sB}, ${sA * 1.0})`);
  specGrad.addColorStop(0.45, `rgba(${sR}, ${sG}, ${sB}, ${sA * 0.6})`);
  specGrad.addColorStop(0.85, `rgba(${sR}, ${sG}, ${sB}, ${sA * 0.25})`);
  specGrad.addColorStop(1.00, `rgba(${sR}, ${sG}, ${sB}, 0)`);
  ctx.fillStyle = specGrad;
  ctx.fillRect(-r * 0.34, -tubeLen / 2, 1.4, tubeLen);
  ctx.restore();

  // Patina speckles (jade-green for brass, blue-grey for ceramic, algae for
  // bamboo — color follows themePalette.patina). Deterministic per tube.
  ctx.fillStyle = patina;
  const seed = c.hueShift * 1000;
  for (let k = 0; k < 5; k++) {
    const sx = ((seed + k * 137) % 100) / 100;
    const sy = ((seed + k * 211) % 100) / 100;
    const px = -r * 0.55 + sx * r * 1.1;
    const py = -tubeLen / 2 + 16 + sy * (tubeLen - 32);
    ctx.beginPath();
    ctx.arc(px, py, 0.6 + (sx * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Top cap (theme-colored) ──────────────────────────────────────────────
  const capR = r * 0.95;
  const capH = r * 0.55;
  ctx.save();
  ctx.translate(0, -tubeLen / 2);
  const capGrad = ctx.createRadialGradient(-capR * 0.3, -capH * 0.4, 1, 0, 0, capR);
  capGrad.addColorStop(0, capCenter);
  capGrad.addColorStop(0.55, capMid);
  capGrad.addColorStop(1, capRim);
  ctx.beginPath();
  ctx.ellipse(0, 0, capR, capH, 0, Math.PI, 2 * Math.PI);
  ctx.lineTo(capR, 0);
  ctx.lineTo(-capR, 0);
  ctx.closePath();
  ctx.fillStyle = capGrad;
  ctx.fill();
  // Cap upper-rim highlight
  ctx.beginPath();
  ctx.ellipse(0, 0, capR * 0.85, capH * 0.85, 0, Math.PI * 1.05, Math.PI * 1.55);
  ctx.strokeStyle = lerp('rgba(255, 230, 180, 0.6)', 'rgba(255, 240, 220, 0.55)');
  ctx.lineWidth = 0.7;
  ctx.stroke();
  // Cord eyelet
  ctx.beginPath();
  ctx.arc(0, -capH * 0.65, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0805';
  ctx.fill();
  // Cap-to-tube shadow line
  ctx.beginPath();
  ctx.moveTo(-capR * 0.95, 0.5);
  ctx.lineTo(capR * 0.95, 0.5);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();

  // ── Bottom rim — open tube end (theme-colored) ────────────────────────────
  ctx.save();
  ctx.translate(0, tubeLen / 2);
  // Inner shadow
  ctx.beginPath();
  ctx.ellipse(0, -1.5, r * 0.78, r * 0.32, 0, 0, Math.PI * 2);
  const innerGrad = ctx.createLinearGradient(0, -3, 0, 1);
  innerGrad.addColorStop(0, innerTop);
  innerGrad.addColorStop(1, innerBot);
  ctx.fillStyle = innerGrad;
  ctx.fill();
  // Wall-thickness rim (lit from upper-left)
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.95, r * 0.42, 0, 0, Math.PI);
  ctx.strokeStyle = rimGlow;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Inner-left rim glint
  ctx.beginPath();
  ctx.arc(-r * 0.4, -1, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = lerp('rgba(255, 232, 178, 0.45)', 'rgba(255, 244, 220, 0.42)');
  ctx.fill();
  ctx.restore();

  // Glow when ringing — outer aura
  if (c.glow > 0.001) {
    const auraR = r * 2.6;
    const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, auraR);
    aura.addColorStop(0, `rgba(255, 220, 158, ${c.glow * 0.32})`);
    aura.addColorStop(1, 'rgba(255, 220, 158, 0)');
    ctx.fillStyle = aura;
    ctx.fillRect(-auraR, -tubeLen / 2 - auraR, auraR * 2, tubeLen + auraR * 2);
  }

  ctx.restore();
}

// ── Striker rendering ────────────────────────────────────────────────────────
// A walnut-stained wood disc on a thin cord, with a leaf-shaped wind catcher
// hanging beneath. The disc is the visual anchor at the bottom of the chimes.
function drawStriker(ctx: CanvasRenderingContext2D, s: Striker) {
  const sin = Math.sin(s.angle), cos = Math.cos(s.angle);
  const x1 = s.anchorX, y1 = s.anchorY;
  // Disc center (end of pendulum)
  const dx = x1 + s.L * sin;
  const dy = y1 + s.L * cos;
  // Catcher hangs further along the same axis below the disc
  const cx = dx + s.catcherL * sin;
  const cy = dy + s.catcherL * cos;

  // Cord from beam to disc — fine charcoal
  ctx.beginPath();
  ctx.moveTo(x1, y1 - 4);
  ctx.lineTo(dx, dy);
  ctx.strokeStyle = 'rgba(20, 14, 8, 0.78)';
  ctx.lineWidth = 0.85;
  ctx.stroke();

  // Cord from disc to catcher
  ctx.beginPath();
  ctx.moveTo(dx, dy);
  ctx.lineTo(cx, cy);
  ctx.strokeStyle = 'rgba(20, 14, 8, 0.78)';
  ctx.lineWidth = 0.85;
  ctx.stroke();

  // Catcher — leaf shape (almond), drawn first so disc covers it where they meet
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(cy - dy, cx - dx) - Math.PI / 2);
  // Leaf
  ctx.beginPath();
  ctx.moveTo(0, -s.catcherH * 0.35);
  ctx.bezierCurveTo(s.catcherW * 0.6, -s.catcherH * 0.15, s.catcherW * 0.6, s.catcherH * 0.45, 0, s.catcherH * 0.65);
  ctx.bezierCurveTo(-s.catcherW * 0.6, s.catcherH * 0.45, -s.catcherW * 0.6, -s.catcherH * 0.15, 0, -s.catcherH * 0.35);
  ctx.closePath();
  const leafGrad = ctx.createLinearGradient(-s.catcherW, 0, s.catcherW, 0);
  leafGrad.addColorStop(0, '#3b2a18');
  leafGrad.addColorStop(0.5, '#5a4226');
  leafGrad.addColorStop(1, '#2a1d10');
  ctx.fillStyle = leafGrad;
  ctx.fill();
  // Leaf central vein
  ctx.beginPath();
  ctx.moveTo(0, -s.catcherH * 0.32);
  ctx.lineTo(0, s.catcherH * 0.6);
  ctx.strokeStyle = 'rgba(232, 200, 150, 0.18)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();

  // Disc — turned wood with concentric grain
  ctx.save();
  ctx.translate(dx, dy);
  // Drop shadow
  ctx.beginPath();
  ctx.arc(2, 2.5, s.discR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.filter = 'blur(2.5px)';
  ctx.fill();
  ctx.filter = 'none';
  // Disc body — radial wood gradient
  const woodGrad = ctx.createRadialGradient(-3, -3, 1, 0, 0, s.discR);
  woodGrad.addColorStop(0, '#7a5a32');
  woodGrad.addColorStop(0.7, '#4a341c');
  woodGrad.addColorStop(1, '#221610');
  ctx.beginPath();
  ctx.arc(0, 0, s.discR, 0, Math.PI * 2);
  ctx.fillStyle = woodGrad;
  ctx.fill();
  // Concentric grain rings
  for (let k = 1; k <= 3; k++) {
    ctx.beginPath();
    ctx.arc(-1, -1, s.discR * (0.4 + k * 0.2), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(20, 12, 6, ${0.35 - k * 0.08})`;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
  // Top highlight rim
  ctx.beginPath();
  ctx.arc(0, 0, s.discR - 0.5, Math.PI * 1.1, Math.PI * 1.95);
  ctx.strokeStyle = 'rgba(220, 188, 138, 0.32)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  // Glow when struck
  if (s.glow > 0.01) {
    ctx.beginPath();
    const auraR = s.discR * 2.4;
    const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, auraR);
    aura.addColorStop(0, `rgba(255, 220, 160, ${s.glow * 0.32})`);
    aura.addColorStop(1, 'rgba(255, 220, 160, 0)');
    ctx.fillStyle = aura;
    ctx.arc(0, 0, auraR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

function ctx2dLetterSpacing(ctx: CanvasRenderingContext2D, value: string) {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = value;
}
