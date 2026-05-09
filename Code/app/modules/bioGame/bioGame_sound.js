/**
 * BioGameSound — sound logic for bioGame.
 *
 * Signal graph during a block:
 *   ambienceSrc → ambienceGain ─┐
 *                                ├─→ blockFadeGain → destination
 *   noiseSrc    → noiseGain    ─┘
 *
 * blockFadeGain ramps 0→1 on startBlock and 1→0 on stopBlock.
 * noiseGain is updated in real-time via setNoiseLevel().
 * File paths come from the scene definition passed to init().
 */

import { SoundEngine } from '../sound/soundEngine.js';
import { LoopPlayer }  from '../sound/loopPlayer.js';
import { SOUND_CONFIG as CFG } from './bioGame_sound_config.js';

export class BioGameSound {
  #engine = new SoundEngine();
  #buf    = {};   // { ambience, noise, miss, collect[] } → AudioBuffer | null

  #ambience       = null;   // LoopPlayer
  #noise          = null;   // LoopPlayer
  #blockFadeGain  = null;   // GainNode — master fade for block layer

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(sounds) {
    await this.#engine.init();
    const [ambience, noise, miss, ...collectBufs] = await Promise.all([
      this.#engine.loadBuffer(sounds.ambience),
      this.#engine.loadBuffer(sounds.noise),
      this.#engine.loadBuffer(sounds.miss),
      ...sounds.collect.map(url => this.#engine.loadBuffer(url)),
    ]);
    this.#buf = { ambience, noise, miss, collect: collectBufs };
  }

  // ── Block layer ───────────────────────────────────────────────────────────

  startBlock() {
    this.#engine.resume();

    this.#ambience?.stop(0);
    this.#noise?.stop(0);
    this.#blockFadeGain?.disconnect();

    const fg = this.#engine.createGain(0);
    fg.connect(this.#engine.destination);
    const t = this.#engine.ctx.currentTime;
    fg.gain.setValueAtTime(0, t);
    fg.gain.linearRampToValueAtTime(1, t + CFG.FADE_SECS);
    this.#blockFadeGain = fg;

    this.#ambience = new LoopPlayer(this.#engine.ctx, this.#buf.ambience);
    this.#ambience.start(fg, { gain: CFG.AMBIENCE_VOLUME });

    this.#noise = new LoopPlayer(this.#engine.ctx, this.#buf.noise);
    this.#noise.start(fg, { gain: CFG.NOISE_VOLUME_MIN });
  }

  // Call every frame during PLAYING.  level ∈ [0, 1].
  setNoiseLevel(level) {
    const target = CFG.NOISE_VOLUME_MIN +
      Math.max(0, Math.min(1, level)) * (CFG.NOISE_VOLUME_MAX - CFG.NOISE_VOLUME_MIN);
    this.#noise?.setGain(target, 0.05);
  }

  // ── One-shot events ───────────────────────────────────────────────────────

  playCollect() {
    const bufs = this.#buf.collect;
    if (!bufs?.length) return;
    const buf = bufs[Math.floor(Math.random() * bufs.length)];
    this.#playOnce(buf, CFG.COLLECT_VOLUME);
  }

  playMiss() {
    this.#playOnce(this.#buf.miss, CFG.MISS_VOLUME);
  }

  #playOnce(buffer, gain) {
    if (!buffer || !this.#engine.ctx) return;
    const src = this.#engine.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.#engine.createGain(gain);
    src.connect(g);
    g.connect(this.#engine.destination);
    src.start();
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  stopBlock() {
    const fg = this.#blockFadeGain;
    if (!fg) return;

    const t = this.#engine.ctx.currentTime;
    fg.gain.cancelScheduledValues(t);
    fg.gain.setValueAtTime(fg.gain.value, t);
    fg.gain.linearRampToValueAtTime(0, t + CFG.FADE_SECS);

    const ambience = this.#ambience;
    const noise    = this.#noise;
    this.#ambience      = null;
    this.#noise         = null;
    this.#blockFadeGain = null;

    setTimeout(() => {
      ambience?.stop(0);
      noise?.stop(0);
      fg.disconnect();
    }, (CFG.FADE_SECS + 0.15) * 1000);
  }
}
