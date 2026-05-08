/**
 * SoundEngine — thin AudioContext wrapper.
 *
 * Responsibilities:
 *   - Own the AudioContext instance
 *   - Load AudioBuffers from URLs (graceful warn on missing files)
 *   - Provide small helpers used by LoopPlayer and higher-level modules
 *
 * Everything that is experiment-specific (which files to load, how to wire
 * them, when to fade) lives outside this class.
 */
export class SoundEngine {
  #ctx = null;

  async init() {
    this.#ctx = new AudioContext();
  }

  get ctx()         { return this.#ctx; }
  get destination() { return this.#ctx.destination; }

  resume() {
    this.#ctx?.resume().catch(() => {});
  }

  createGain(value = 1) {
    const g = this.#ctx.createGain();
    g.gain.value = value;
    return g;
  }

  /**
   * Load a URL into an AudioBuffer.
   * Returns null (with a console warning) if the file is missing or
   * undecodable — callers must handle null gracefully.
   */
  async loadBuffer(url) {
    if (!this.#ctx) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await this.#ctx.decodeAudioData(await res.arrayBuffer());
    } catch (e) {
      console.warn(`[Sound] could not load "${url}": ${e.message}`);
      return null;
    }
  }
}
