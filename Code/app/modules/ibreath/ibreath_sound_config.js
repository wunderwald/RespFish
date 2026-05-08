// iBreath sound configuration.
// Paths are relative to the Electron app root (app/).
// Volumes are linear 0–1.

export const SOUND_CONFIG = {
  // ── Files ───────────────────────────────────────────────────────────────
  AMBIENCE: 'sounds/ambience.wav',   // steady background loop during trial
  NOISE:    'sounds/noise.wav',      // resp-driven loop during trial
  JINGLE:   'sounds/jingle.wav',     // loop played during pre-trial animation

  // ── Levels ──────────────────────────────────────────────────────────────
  AMBIENCE_VOLUME:   0.5,   // fixed ambience level
  NOISE_VOLUME_MIN:  0.0,   // noise gain at stimulus level 0
  NOISE_VOLUME_MAX:  0.8,   // noise gain at stimulus level 1
  JINGLE_VOLUME:     0.6,

  // ── Timing ──────────────────────────────────────────────────────────────
  FADE_SECS: 1.0,           // fade-in / fade-out duration
};
