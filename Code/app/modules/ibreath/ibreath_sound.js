/**
 * IBreathSound — experiment-specific sound logic for iBreath.
 *
 * Uses the general SoundEngine + LoopPlayer primitives from app/modules/sound/.
 *
 * Trial layer signal graph:
 *   ambienceSrc → ambienceGain ─┐
 *                                ├─→ trialFadeGain → destination
 *   noiseSrc    → noiseGain    ─┘
 *
 * Display layer signal graph:
 *   jingleSrc → jingleGain (fade) → destination
 *
 * trialFadeGain ramps 0→1 on startTrial and 1→0 on stopTrial, so both
 * trial sounds fade in and out together as one unit.
 * noiseGain is updated in real-time via setNoiseLevel().
 * The jingle handles its own fade via LoopPlayer.start/stop.
 */

import { SoundEngine } from '../sound/soundEngine.js';
import { LoopPlayer }  from '../sound/loopPlayer.js';
import { SOUND_CONFIG as CFG } from './ibreath_sound_config.js';

export class IBreathSound {
  #engine = new SoundEngine();
  #buf    = {};   // { ambience, noise, jingle } → AudioBuffer | null

  // Trial layer
  #ambience      = null;   // LoopPlayer
  #noise         = null;   // LoopPlayer
  #trialFadeGain = null;   // GainNode — master fade for trial layer

  // Display layer
  #jingle = null;          // LoopPlayer

  // ── Init ──────────────────────────────────────────────────────────────────

  async init() {
    await this.#engine.init();
    const [ambience, noise, jingle] = await Promise.all([
      this.#engine.loadBuffer(CFG.AMBIENCE),
      this.#engine.loadBuffer(CFG.NOISE),
      this.#engine.loadBuffer(CFG.JINGLE),
    ]);
    this.#buf = { ambience, noise, jingle };
  }

  // ── Trial layer ───────────────────────────────────────────────────────────

  startTrial() {
    this.#engine.resume();

    // Kill any stale trial sounds immediately (e.g. rapid restart)
    this.#ambience?.stop(0);
    this.#noise?.stop(0);
    this.#trialFadeGain?.disconnect();

    // Master fade: 0 → 1 over FADE_SECS
    const fg = this.#engine.createGain(0);
    fg.connect(this.#engine.destination);
    const t = this.#engine.ctx.currentTime;
    fg.gain.setValueAtTime(0, t);
    fg.gain.linearRampToValueAtTime(1, t + CFG.FADE_SECS);
    this.#trialFadeGain = fg;

    this.#ambience = new LoopPlayer(this.#engine.ctx, this.#buf.ambience);
    this.#ambience.start(fg, { gain: CFG.AMBIENCE_VOLUME });

    this.#noise = new LoopPlayer(this.#engine.ctx, this.#buf.noise);
    this.#noise.start(fg, { gain: CFG.NOISE_VOLUME_MIN });
  }

  // Call every update frame during STATE.TRIAL.  level ∈ [0, 1].
  setNoiseLevel(level) {
    const target = CFG.NOISE_VOLUME_MIN +
      Math.max(0, Math.min(1, level)) * (CFG.NOISE_VOLUME_MAX - CFG.NOISE_VOLUME_MIN);
    this.#noise?.setGain(target, 0.05);   // 50 ms smoothing to avoid clicks
  }

  stopTrial() {
    const fg = this.#trialFadeGain;
    if (!fg) return;

    // Fade master gain 1 → 0, then stop sources and disconnect
    const t = this.#engine.ctx.currentTime;
    fg.gain.cancelScheduledValues(t);
    fg.gain.setValueAtTime(fg.gain.value, t);
    fg.gain.linearRampToValueAtTime(0, t + CFG.FADE_SECS);

    const ambience = this.#ambience;
    const noise    = this.#noise;
    this.#ambience      = null;
    this.#noise         = null;
    this.#trialFadeGain = null;

    setTimeout(() => {
      ambience?.stop(0);
      noise?.stop(0);
      fg.disconnect();
    }, (CFG.FADE_SECS + 0.15) * 1000);
  }

  // ── Display layer ─────────────────────────────────────────────────────────

  startDisplay() {
    this.#engine.resume();
    this.#jingle?.stop(0);   // kill any stale jingle immediately
    this.#jingle = new LoopPlayer(this.#engine.ctx, this.#buf.jingle);
    this.#jingle.start(this.#engine.destination, {
      gain:      CFG.JINGLE_VOLUME,
      fadeInSecs: CFG.FADE_SECS,
    });
  }

  stopDisplay() {
    this.#jingle?.stop(CFG.FADE_SECS);
    this.#jingle = null;
  }
}
