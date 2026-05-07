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
// Pendulum tuning. The values below give the longest tube (L≈489px) a
// natural period of ~2.8s and a damping ratio of ~0.11 — visibly oscillates
// then settles in ~6–8 seconds, like a real metal chime. Wind in this
// regime moves the tubes only 1–3° at ambient and 3–6° during gusts.
const GRAVITY = 2500;                // px/s² equivalent — strong enough to return tubes from any tilt in <2s
const DAMPING = 0.5;                 // per-second angular damping (under-damped)
const TAP_IMPULSE = 1.0;             // initial angular velocity from a tap, rad/s — swings to ~25°
const COLLIDE_RESTITUTION = 0.55;
const RING_VEL_THRESHOLD = 0.4;      // min closing velocity to ring (raised for the new faster physics)
const RING_COOLDOWN_MS = 110;        // a single chime can't ring more than this often
const MAX_ANGLE = 0.95;              // ~54° — beyond this physics looks wrong + tubes overlap massively
const COLLISION_GAP = 1.2;           // post-resolution separation in px to prevent re-touching
const WIND_FORCE_SCALE = 0.9;        // multiplier on wind acceleration (chime), tuned with gravity above
const STRIKER_WIND_SCALE = 0.76;     // striker catches more wind (leaf surface) but its mass is bigger

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
  const ripplesRef = useRef<Ripple[]>([]);
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
  // hammered-tube character. Slow exponential decay (~3-4 sec). Velocity
  // influences gain + slight brightness (overtone gains).
  function ringBell(freq: number, vel: number) {
    const ctx = audioCtxRef.current;
    const out = masterGainRef.current;
    if (!ctx || !out || ctx.state !== 'running') return;
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
    // tiny noise tick on attack — like the mallet contact
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
        // Decay the glow envelope toward 0
        c.glow = Math.max(0, c.glow - dt * 1.6);
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
                  a.glow = Math.max(a.glow, vel);
                }
                if (now - b.lastRingMs > RING_COOLDOWN_MS) {
                  ringBell(b.freq, vel * 0.85);
                  b.lastRingMs = now;
                  b.glow = Math.max(b.glow, vel);
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
      // Sky gradient: ink at top → pale jade-grey at bottom
      const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
      skyGrad.addColorStop(0, '#0a141c');
      skyGrad.addColorStop(0.55, '#162028');
      skyGrad.addColorStop(1, '#243038');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, h);

      // Stars (drawn before moon so moon glow can overlay them)
      const stars = starsRef.current;
      for (const s of stars) {
        const a = s.baseA * (0.55 + 0.45 * Math.sin(now * 0.001 + s.phase));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(218, 226, 218, ${a * 0.65})`;
        ctx.fill();
      }

      // ── Moon — luminous, hazy, with subtle maria — drawn as layered passes:
      //   (1) far halo: very wide, very faint atmospheric scatter
      //   (2) close haze: tighter glow around the disc
      //   (3) disc: cream-warm radial with off-center light origin
      //   (4) maria: 3 subtle darker patches (lunar seas) for surface texture
      //   (5) corona: thin bright rim catching the limb
      // No hard concentric rings — the moon should feel like it's behind a
      // thin veil of cloud, not a clip-art sticker.
      const moonX = w * 0.19, moonY = h * 0.165;
      const moonDiscR = 24;
      // (1) Far atmospheric halo — vast, very dim, warm-cool blend
      const farHalo = ctx.createRadialGradient(moonX, moonY, moonDiscR * 0.5, moonX, moonY, h * 0.55);
      farHalo.addColorStop(0, 'rgba(232, 226, 200, 0.18)');
      farHalo.addColorStop(0.25, 'rgba(200, 210, 198, 0.07)');
      farHalo.addColorStop(0.6, 'rgba(170, 188, 188, 0.03)');
      farHalo.addColorStop(1, 'rgba(170, 188, 188, 0)');
      ctx.fillStyle = farHalo;
      ctx.fillRect(0, 0, w, h);
      // (2) Close haze — tight, slightly warmer, blooms beyond the disc edge
      const closeHaze = ctx.createRadialGradient(moonX, moonY, moonDiscR * 0.85, moonX, moonY, moonDiscR * 3.2);
      closeHaze.addColorStop(0, 'rgba(245, 234, 198, 0.32)');
      closeHaze.addColorStop(0.4, 'rgba(220, 218, 198, 0.10)');
      closeHaze.addColorStop(1, 'rgba(220, 218, 198, 0)');
      ctx.fillStyle = closeHaze;
      ctx.fillRect(0, 0, w, h);
      // (3) Disc — radial gradient with off-center light source upper-left
      const disc = ctx.createRadialGradient(
        moonX - 6, moonY - 7, 0.5,
        moonX, moonY, moonDiscR,
      );
      disc.addColorStop(0, 'rgba(252, 245, 218, 0.98)');     // brightest highlight
      disc.addColorStop(0.5, 'rgba(232, 222, 188, 0.93)');   // warm cream body
      disc.addColorStop(0.85, 'rgba(196, 192, 168, 0.78)');  // limb
      disc.addColorStop(1, 'rgba(170, 174, 158, 0.0)');      // soft falloff (no hard edge)
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonDiscR, 0, Math.PI * 2);
      ctx.fillStyle = disc;
      ctx.fill();
      // (4) Maria — three soft darker patches on the sunlit face. Static
      // positions so the moon doesn't "rotate". Drawn with low alpha radial
      // gradients clipped to the moon disc.
      ctx.save();
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonDiscR - 0.5, 0, Math.PI * 2);
      ctx.clip();
      const maria: Array<[number, number, number, number]> = [
        // [dx, dy, radius, alpha]
        [-3, 1, 8, 0.18],
        [4, -2, 5.5, 0.14],
        [-1, 5, 4, 0.12],
      ];
      for (const [dx, dy, mr, ma] of maria) {
        const m = ctx.createRadialGradient(moonX + dx, moonY + dy, 0, moonX + dx, moonY + dy, mr);
        m.addColorStop(0, `rgba(150, 145, 128, ${ma})`);
        m.addColorStop(1, 'rgba(150, 145, 128, 0)');
        ctx.fillStyle = m;
        ctx.fillRect(moonX - moonDiscR, moonY - moonDiscR, moonDiscR * 2, moonDiscR * 2);
      }
      ctx.restore();
      // (5) Corona — thin bright crescent on the upper-left limb, suggesting
      // backlight catching the edge. Drawn as a clipped arc stroke.
      ctx.save();
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonDiscR - 0.6, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonDiscR + 0.4, Math.PI * 0.95, Math.PI * 1.75);
      ctx.strokeStyle = 'rgba(255, 246, 220, 0.7)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
      // Outer gentle glow — a single ultra-soft outline (no concentric rings)
      const outerGlow = ctx.createRadialGradient(moonX, moonY, moonDiscR, moonX, moonY, moonDiscR + 12);
      outerGlow.addColorStop(0, 'rgba(255, 245, 215, 0.18)');
      outerGlow.addColorStop(1, 'rgba(255, 245, 215, 0)');
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonDiscR + 12, 0, Math.PI * 2);
      ctx.fill();

      // Mist
      for (const m of mistRef.current) {
        const a = m.alpha * (0.7 + Math.sin(m.phase) * 0.25);
        const grad = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size);
        grad.addColorStop(0, `rgba(200, 215, 210, ${a})`);
        grad.addColorStop(1, 'rgba(200, 215, 210, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(m.x - m.size, m.y - m.size, m.size * 2, m.size * 2);
      }

      // Vignette — slight darkening at edges
      const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 0.85);
      vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vg.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // ── Title — 風鈴 in serif, debossed-into-mist style ───────────────────
      // In poster mode treat the user as already-engaged so the breath hint
      // doesn't render in the marketing image.
      drawTitle(ctx, w, h, hasTouchedRef.current || isPoster);

      // ── Beam (the wood that holds the chimes) ─────────────────────────────
      const beamY = h * 0.13;
      const beamH = 14;
      const beamGrad = ctx.createLinearGradient(0, beamY, 0, beamY + beamH);
      beamGrad.addColorStop(0, '#0a0908');
      beamGrad.addColorStop(0.5, '#1c1612');
      beamGrad.addColorStop(1, '#0a0807');
      ctx.fillStyle = beamGrad;
      ctx.fillRect(0, beamY, w, beamH);
      // Beam top highlight (faint)
      ctx.fillStyle = 'rgba(180, 162, 120, 0.08)';
      ctx.fillRect(0, beamY, w, 1);
      // Beam bottom shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, beamY + beamH, w, 6);

      // Brass eyelets where strings meet beam
      for (const c of chimes) {
        ctx.beginPath();
        ctx.arc(c.anchorX, beamY + beamH - 1, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = '#a8895a';
        ctx.fill();
      }

      // ── Strings + tubes ───────────────────────────────────────────────────
      for (let i = 0; i < chimes.length; i++) {
        drawChime(ctx, chimes[i]);
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
      hit.glow = 1;
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
      {!hasTouched && !isPoster && (
        <div className="wc__hint">tap a chime · breathe</div>
      )}
      {!isPoster && <div className="wc__brand">courtyard study</div>}
    </div>
  );
}

// ── Title rendering — 風鈴 in Noto Serif SC, very softly debossed ─────────────
function drawTitle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  hasTouched: boolean,
) {
  const cx = w / 2;
  const cy = h * 0.83;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Horizontal Chinese title with western subtitle below.
  ctx.font = '300 36px "Noto Serif SC", "Cormorant Garamond", serif';
  ctx2dLetterSpacing(ctx, '0.42em');
  // Soft glow below (bottom-rim catches the moonlight)
  ctx.fillStyle = 'rgba(214, 222, 214, 0.10)';
  ctx.fillText('風鈴', cx + 7, cy + 1);
  // Main fill — quiet but legible
  ctx.fillStyle = 'rgba(220, 230, 222, 0.50)';
  ctx.fillText('風鈴', cx + 7, cy);

  // Western subtitle in italic Cormorant
  ctx2dLetterSpacing(ctx, '0.34em');
  ctx.font = '300 italic 11px "Cormorant Garamond", serif';
  ctx.fillStyle = 'rgba(214, 222, 214, 0.42)';
  ctx.fillText('wind chime', cx + 1.5, cy + 28);

  if (!hasTouched) {
    ctx2dLetterSpacing(ctx, '0.32em');
    ctx.font = '300 9px "JetBrains Mono", ui-monospace, monospace';
    const breath = 0.45 + Math.sin(performance.now() * 0.0022) * 0.22;
    ctx.fillStyle = `rgba(196, 210, 198, ${breath})`;
    ctx.fillText('TAP A TUBE · BREATHE', cx + 4, cy + 56);
  }
  ctx.restore();
}

// ── Tube rendering ───────────────────────────────────────────────────────────
function drawChime(ctx: CanvasRenderingContext2D, c: Chime) {
  const sin = Math.sin(c.angle), cos = Math.cos(c.angle);
  const x1 = c.anchorX, y1 = c.anchorY;
  const x2 = x1 + c.L * sin;
  const y2 = y1 + c.L * cos;

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

  // ── Cylindrical brass body ────────────────────────────────────────────────
  // Eight-stop horizontal gradient that simulates a polished cylinder under a
  // soft upper-left light source: dark left rim (back of cylinder away from
  // light) → ramp up to a peak highlight just left of center → warm mid-body
  // → deep shadow side → faint cool sky-reflection rim on the right edge.
  const hue = c.hueShift;
  const hueShift = (n: number) => Math.floor(hue * n);
  // Aged brass palette — slightly more reddish/patina than pure yellow brass
  const C_BACK_RIM   = `rgb(${48 + hueShift(8)}, ${36 + hueShift(6)}, ${20 + hueShift(6)})`;   // far-left, away from light
  const C_RAMP       = `rgb(${112 + hueShift(12)}, ${82 + hueShift(8)}, ${42 + hueShift(8)})`;
  const C_HIGHLIGHT  = `rgb(${224 + hueShift(8)}, ${198 + hueShift(6)}, ${138 + hueShift(10)})`; // warm glint
  const C_BODY       = `rgb(${158 + hueShift(12)}, ${122 + hueShift(8)}, ${64 + hueShift(10)})`;
  const C_BODY_DEEP  = `rgb(${96 + hueShift(10)}, ${72 + hueShift(6)}, ${36 + hueShift(8)})`;
  const C_SHADOW     = `rgb(${42 + hueShift(8)}, ${30 + hueShift(6)}, ${16 + hueShift(6)})`;
  const C_RIM_COOL   = `rgb(${72 + hueShift(8)}, ${68 + hueShift(6)}, ${52 + hueShift(8)})`;    // sky bounce on far edge

  const grad = ctx.createLinearGradient(-r, 0, r, 0);
  grad.addColorStop(0.00, C_BACK_RIM);
  grad.addColorStop(0.10, C_RAMP);
  grad.addColorStop(0.28, C_HIGHLIGHT);
  grad.addColorStop(0.42, C_BODY);
  grad.addColorStop(0.65, C_BODY_DEEP);
  grad.addColorStop(0.88, C_SHADOW);
  grad.addColorStop(0.97, C_SHADOW);
  grad.addColorStop(1.00, C_RIM_COOL);
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.fillStyle = grad;
  ctx.fill();

  // Vertical shading: top is slightly cooler (catches sky), bottom slightly
  // warmer (catches reflected light from striker / wood disc below).
  const vert = ctx.createLinearGradient(0, -tubeLen / 2, 0, tubeLen / 2);
  vert.addColorStop(0, 'rgba(180, 200, 215, 0.10)');     // sky tint at top
  vert.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  vert.addColorStop(0.85, 'rgba(0, 0, 0, 0)');
  vert.addColorStop(1, 'rgba(220, 160, 90, 0.18)');      // warm bounce near bottom
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.fillStyle = vert;
  ctx.fill();

  // Lathe lines: extremely faint horizontal ridges, like turning marks on a
  // machined tube. Spacing varies subtly per tube using hueShift.
  ctx.save();
  ctx.beginPath();
  roundedRectPath(ctx, -r, -tubeLen / 2, r * 2, tubeLen, r * 0.85);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
  ctx.lineWidth = 0.5;
  const ridgeStep = 7 + hue * 2;
  for (let y = -tubeLen / 2 + 4; y < tubeLen / 2 - 4; y += ridgeStep) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.95, y);
    ctx.lineTo(r * 0.95, y);
    ctx.stroke();
  }
  // Faint warm specular line at left highlight (very thin, very bright)
  const specGrad = ctx.createLinearGradient(0, -tubeLen / 2, 0, tubeLen / 2);
  specGrad.addColorStop(0.00, 'rgba(255, 240, 200, 0)');
  specGrad.addColorStop(0.10, 'rgba(255, 240, 200, 0.55)');
  specGrad.addColorStop(0.45, 'rgba(255, 240, 200, 0.32)');
  specGrad.addColorStop(0.85, 'rgba(255, 240, 200, 0.14)');
  specGrad.addColorStop(1.00, 'rgba(255, 240, 200, 0)');
  ctx.fillStyle = specGrad;
  ctx.fillRect(-r * 0.34, -tubeLen / 2, 1.4, tubeLen);
  ctx.restore();

  // Patina speckles — a handful of jade-green oxidation spots, deterministic
  // per tube via hueShift so they don't shimmer between frames
  ctx.fillStyle = 'rgba(56, 78, 64, 0.42)';
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

  // ── Top cap — turned brass collar with cord eyelet ───────────────────────
  // Drawn as a slightly-flatter half-disc that overhangs the tube by ~r*0.15
  const capR = r * 0.95;
  const capH = r * 0.55;
  ctx.save();
  ctx.translate(0, -tubeLen / 2);
  // Cap body — radial gradient to fake convex surface
  const capGrad = ctx.createRadialGradient(-capR * 0.3, -capH * 0.4, 1, 0, 0, capR);
  capGrad.addColorStop(0, '#f0d490');
  capGrad.addColorStop(0.55, '#a48142');
  capGrad.addColorStop(1, '#3e2c14');
  ctx.beginPath();
  // Half-ellipse on top of tube
  ctx.ellipse(0, 0, capR, capH, 0, Math.PI, 2 * Math.PI);
  ctx.lineTo(capR, 0);
  ctx.lineTo(-capR, 0);
  ctx.closePath();
  ctx.fillStyle = capGrad;
  ctx.fill();
  // Tiny upper-rim highlight on the cap
  ctx.beginPath();
  ctx.ellipse(0, 0, capR * 0.85, capH * 0.85, 0, Math.PI * 1.05, Math.PI * 1.55);
  ctx.strokeStyle = 'rgba(255, 230, 180, 0.6)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  // Cord eyelet (tiny darker hole at top center of cap)
  ctx.beginPath();
  ctx.arc(0, -capH * 0.65, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0805';
  ctx.fill();
  // A thin shadow line where the cap meets the tube
  ctx.beginPath();
  ctx.moveTo(-capR * 0.95, 0.5);
  ctx.lineTo(capR * 0.95, 0.5);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();

  // ── Bottom rim — open tube end with a thin warm inner glow ────────────────
  ctx.save();
  ctx.translate(0, tubeLen / 2);
  // Inner shadow (open tube interior — a dark crescent)
  ctx.beginPath();
  ctx.ellipse(0, -1.5, r * 0.78, r * 0.32, 0, 0, Math.PI * 2);
  const innerGrad = ctx.createLinearGradient(0, -3, 0, 1);
  innerGrad.addColorStop(0, '#0c0805');
  innerGrad.addColorStop(1, '#241a0e');
  ctx.fillStyle = innerGrad;
  ctx.fill();
  // Bottom-edge brass rim (the wall thickness, lit from above-left)
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.95, r * 0.42, 0, 0, Math.PI);
  ctx.strokeStyle = 'rgba(220, 178, 110, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Highlight glint on inner-left of rim
  ctx.beginPath();
  ctx.arc(-r * 0.4, -1, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 232, 178, 0.45)';
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
