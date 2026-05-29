/* Pioneer DCR Hub — shared celebrate helper (sound + confetti).
 *
 * Two surfaces:
 *   1. playDcrSuccessSound()                  — tiny audio cue
 *   2. PioneerCelebrate.fire({ intensity })   — tasteful confetti burst
 *
 * Rules:
 *   • Both APIs ONLY fire on a user action — autoplay-blocked browsers
 *     reject silently.
 *   • Reduced-motion preference disables confetti (sound still plays).
 *   • localStorage `pioneerops_sounds_enabled` === "false" disables
 *     audio. (Default ON. Future settings UI can flip it.)
 *   • Every call is wrapped in try/catch — celebration must NEVER block
 *     the success path it decorates.
 *
 * Confetti is hand-rolled (no library dependency). ~80 lines of canvas
 * code, single-shot bursts that auto-cleanup after ~1.6s. "Subtle, fast,
 * premium" per spec — not endless, not chunky.
 */
(function () {
  "use strict";

  const SOUND_URL    = "/assets/sounds/dcr-success.mp3";
  const SOUND_VOLUME = 0.30;

  // Lazily-loaded Audio so the page boot doesn't hit the network.
  let _audio = null;
  function ensureAudio() {
    if (_audio) return _audio;
    try {
      _audio = new Audio(SOUND_URL);
      _audio.preload = "auto";
      _audio.volume  = SOUND_VOLUME;
    } catch (_e) { _audio = null; }
    return _audio;
  }

  function soundsEnabled() {
    try {
      const v = localStorage.getItem("pioneerops_sounds_enabled");
      // Default ON. Only "false" disables.
      return v !== "false";
    } catch (_e) { return true; }
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_e) { return false; }
  }

  function playDcrSuccessSound() {
    if (!soundsEnabled()) return;
    try {
      const a = ensureAudio();
      if (!a) return;
      // Clone-on-play so rapid double-fires don't cut each other off.
      const clone = a.cloneNode(true);
      clone.volume = SOUND_VOLUME;
      const p = clone.play();
      if (p && typeof p.then === "function") {
        p.catch(function () { /* autoplay blocked → silent */ });
      }
    } catch (_e) { /* swallow */ }
  }

  /* ---- Confetti ----------------------------------------------------
   *
   * Single canvas appended to body for the duration of a burst, then
   * removed. Particles are simple rectangles with rotation + linear
   * gravity. No persistent animation loop — if no canvas exists, no CPU.
   * Intensity presets:
   *   small  — 28 particles, 1.0s
   *   medium — 60 particles, 1.4s
   *   large  — 110 particles, 1.8s
   * ----------------------------------------------------------------- */

  const COLORS = [
    "#14b8a6", "#0d9488",       // teal (Pioneer accent)
    "#22d3ee", "#06b6d4",       // cyan
    "#f8fafc", "#cbd5e1",       // light slate (soft sparkle)
    "#fbbf24"                   // warm amber accent
  ];

  function fire(opts) {
    opts = opts || {};
    if (prefersReducedMotion()) return;
    const intensity = opts.intensity === "small"  ? "small"
                    : opts.intensity === "large"  ? "large"
                    : "medium";
    const presets = {
      small:  { count: 28,  duration: 1000 },
      medium: { count: 60,  duration: 1400 },
      large:  { count: 110, duration: 1800 }
    };
    const cfg = presets[intensity];

    try {
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;inset:0;pointer-events:none;" +
        "z-index:9998;width:100vw;height:100vh;";
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const W = window.innerWidth;
      const H = window.innerHeight;
      canvas.width  = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      document.body.appendChild(canvas);

      // Spawn particles from two near-top "cannons" so the burst feels
      // wide-shouldered, not centred.
      const particles = [];
      const cannons = [
        { x: W * 0.25, y: H * 0.18, vx0:  0.4 },
        { x: W * 0.75, y: H * 0.18, vx0: -0.4 }
      ];
      for (let i = 0; i < cfg.count; i++) {
        const cannon = cannons[i % cannons.length];
        const angle  = (-Math.PI / 2) + (Math.random() - 0.5) * 1.4; // mostly upward
        const speed  = 6 + Math.random() * 5;
        particles.push({
          x:    cannon.x,
          y:    cannon.y,
          vx:   Math.cos(angle) * speed + cannon.vx0,
          vy:   Math.sin(angle) * speed,
          rot:  Math.random() * Math.PI,
          vrot: (Math.random() - 0.5) * 0.4,
          size: 5 + Math.random() * 6,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          life: 1.0
        });
      }

      const start = Date.now();
      const GRAVITY = 0.22;
      const DRAG    = 0.992;
      function tick() {
        const elapsed = Date.now() - start;
        if (elapsed >= cfg.duration) {
          if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
          return;
        }
        ctx.clearRect(0, 0, W, H);
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.vy += GRAVITY;
          p.vx *= DRAG;
          p.x  += p.vx;
          p.y  += p.vy;
          p.rot += p.vrot;
          p.life = Math.max(0, 1 - elapsed / cfg.duration);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.25));
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.6);
          ctx.restore();
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    } catch (_e) { /* swallow — celebration must never break flow */ }
  }

  // Combined helper — most callers want both effects fired together.
  function celebrate(opts) {
    opts = opts || {};
    if (opts.sound !== false) playDcrSuccessSound();
    fire({ intensity: opts.intensity || "medium" });
  }

  window.PioneerCelebrate    = { fire: fire, celebrate: celebrate };
  window.playDcrSuccessSound = playDcrSuccessSound;
})();
