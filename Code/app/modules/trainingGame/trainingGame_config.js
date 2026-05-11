export const CONFIG = {
  TARGET_BPM: 6,
  GAME_DURATION_SECS: 60,
  EXHALE_ONSET_THRESHOLD: 0.40,
  BREATH_DEBOUNCE_MS: 1500,
  EXHALE_SUCCESS_RATIO: 0.90,

  SUN_RADIUS: 150,
  CLOUD_SIZE: 130,
  CLOUD_SPAWN_DELAY_MS: 200,
  CLOUD_SLIDE_IN_MS: 600,
  CLOUD_SLIDE_MS: 2200,
  FAIL_ORBIT_R: 185,
  FAIL_FADE_MS: 60000,

  // ── Control variant (sharp exhale) ───────────────────────────────────────────
  SHARP_EXHALE_MS:        300,   // exhale must stay above threshold for this long
  SHARP_CLOUD_TIMEOUT_MS: 4000,  // max time in inhale before auto-miss
  SHARP_SPAWN_MIN_MS:      400,  // min delay between clouds
  SHARP_SPAWN_MAX_MS:     2000,  // max delay between clouds
};

export const STATE = {
  IDLE:      'idle',
  COUNTDOWN: 'countdown',
  PLAYING:   'playing',
  GAME_OVER: 'game_over',
};
