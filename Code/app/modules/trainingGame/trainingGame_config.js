export const CONFIG = {
  TARGET_BPM: 6,
  GAME_DURATION_SECS: 60,
  EXHALE_ONSET_THRESHOLD: 0.40,
  BREATH_DEBOUNCE_MS: 1500,
  EXHALE_SUCCESS_RATIO: 0.90,

  SUN_RADIUS: 150,
  CLOUD_SIZE: 130,
  CLOUD_SPAWN_DELAY_MS: 2500,
  CLOUD_SLIDE_IN_MS: 2000,
  CLOUD_SLIDE_MS: 2200,
  FAIL_ORBIT_R: 185,
  FAIL_FADE_MS: 60000,

  // ── Mic calibration (web version) ─────────────────────────────────────────
  CAL_ROUNDS:         3,
  CAL_SILENCE_MS:     2000,
  CAL_BREATH_MS:      2500,
  CAL_MIN_RATIO:      3,      // peak must be >= floor × this to be valid
  CAL_FALLBACK_FLOOR: 0.04,
  CAL_FALLBACK_CEIL:  0.50,
};

export const STATE = {
  IDLE:        'idle',
  CALIBRATING: 'calibrating',
  COUNTDOWN:   'countdown',
  PLAYING:     'playing',
  GAME_OVER:   'game_over',
};
