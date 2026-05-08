/**
 * LoopPlayer — plays a single AudioBuffer as a seamless loop.
 *
 * If the buffer is null (file failed to load) every method is a silent no-op.
 *
 * Signal path:
 *   BufferSourceNode → GainNode → destinationNode (caller-supplied)
 *
 * API:
 *
 *   start(destination, { gain, fadeInSecs })
 *     Begin looping into destination.
 *     gain        — initial gain value (default 1)
 *     fadeInSecs  — ramp from 0 → gain over this many seconds (default 0)
 *
 *   stop(fadeOutSecs)
 *     Fade out and disconnect.  0 = immediate stop.
 *
 *   setGain(value, smoothSecs)
 *     Smooth real-time gain update.
 *     smoothSecs > 0 uses setTargetAtTime (good for continuous updates).
 *     smoothSecs = 0 (default) sets the value immediately.
 *
 *   isPlaying → boolean
 */
export class LoopPlayer {
  #ctx;
  #buffer;
  #source   = null;   // BufferSourceNode
  #gainNode = null;   // GainNode

  constructor(ctx, buffer) {
    this.#ctx    = ctx;
    this.#buffer = buffer;
  }

  // loopCount > 0: play exactly that many times then stop naturally (no fade).
  // loopCount = 0 (default): loop indefinitely until stop() is called.
  start(destination, { gain = 1, fadeInSecs = 0, loopCount = 0 } = {}) {
    if (!this.#buffer || !this.#ctx) return;

    this.#gainNode = this.#ctx.createGain();
    const t = this.#ctx.currentTime;
    if (fadeInSecs > 0) {
      this.#gainNode.gain.setValueAtTime(0, t);
      this.#gainNode.gain.linearRampToValueAtTime(gain, t + fadeInSecs);
    } else {
      this.#gainNode.gain.setValueAtTime(gain, t);
    }
    this.#gainNode.connect(destination);

    this.#source        = this.#ctx.createBufferSource();
    this.#source.buffer = this.#buffer;
    this.#source.loop   = true;
    this.#source.connect(this.#gainNode);
    this.#source.start();

    if (loopCount > 0) {
      this.#source.stop(t + this.#buffer.duration * loopCount);
    }
  }

  stop(fadeOutSecs = 0) {
    if (!this.#gainNode) return;

    const doStop = () => {
      try { this.#source?.stop(); } catch {}
      this.#source?.disconnect();
      this.#gainNode?.disconnect();
      this.#source   = null;
      this.#gainNode = null;
    };

    if (fadeOutSecs > 0) {
      const t = this.#ctx.currentTime;
      this.#gainNode.gain.cancelScheduledValues(t);
      this.#gainNode.gain.setValueAtTime(this.#gainNode.gain.value, t);
      this.#gainNode.gain.linearRampToValueAtTime(0, t + fadeOutSecs);
      setTimeout(doStop, (fadeOutSecs + 0.15) * 1000);
    } else {
      doStop();
    }
  }

  setGain(value, smoothSecs = 0) {
    const g = this.#gainNode?.gain;
    if (!g) return;
    const now = this.#ctx.currentTime;
    g.cancelScheduledValues(now);
    if (smoothSecs > 0) {
      g.setTargetAtTime(value, now, smoothSecs);
    } else {
      g.setValueAtTime(value, now);
    }
  }

  get isPlaying() { return this.#source !== null; }
}
