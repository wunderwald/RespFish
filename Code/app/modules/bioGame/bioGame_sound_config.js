// bioGame sound configuration.
// Paths are relative to the Electron app root (app/).
// Volumes are linear 0–1.

export const SOUND_CONFIG = {
  // ── Files ────────────────────────────────────────────────────────────────
  AMBIENCE: 'sounds/ambience.wav',
  NOISE:    'sounds/breath.wav',
  COLLECT:  ['sounds/collect1.wav', 'sounds/collect2.wav', 'sounds/collect3.wav', 'sounds/collect4.wav'],
  MISS:     'sounds/miss.wav',

  // ── Levels ───────────────────────────────────────────────────────────────
  AMBIENCE_VOLUME:  0.5,
  NOISE_VOLUME_MIN: 0.0,
  NOISE_VOLUME_MAX: 0.8,
  COLLECT_VOLUME:   0.7,
  MISS_VOLUME:      0.6,

  // ── Timing ───────────────────────────────────────────────────────────────
  FADE_SECS: 1.0,
};
