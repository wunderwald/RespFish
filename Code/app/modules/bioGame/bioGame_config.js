export const CONFIG = {
  // ── Experiment ───────────────────────────────────────────────────────────
  SUBJECT_CODE:          'TEST',
  GROUP:                 'slow',   // 'slow' | 'natural'
  SCENE:                 'random',  // 'ocean' | 'jungle' | 'random'
  NATURAL_BPM:           10,
  SHOW_CURVE:            false,
  DATA_DIR:              'output_data/bio_game', // do not change
  SEND_MARKERS:          true,
  MARKER_STREAM_URL:     'ws://localhost:8765',

  // ── Timing ───────────────────────────────────────────────────────────────
  BLOCK_DURATION_SECS:   300,   // 5 minutes per block
  NUM_BLOCKS:            2,
  CALIBRATION_SECS:      30,
  COUNTDOWN_SECS:        3.75,  // 3 + 2 + 1 + GO! each 1s, GO 0.75s

  // TODO: measure real min/max from pilot recordings and replace these placeholders
  DEFAULT_CAL_RANGE:     [0.2, 0.8],  // used if the experimenter chooses "use default" after a failed calibration

  // ── Breath target ────────────────────────────────────────────────────────
  SLOW_BPM:              6,

  // ── Signal processing ────────────────────────────────────────────────────
  SMOOTH_WINDOW:         64,    // GaussianSmoother window

  // ── Avatar ───────────────────────────────────────────────────────────────
  AVATAR_X_RATIO:        0.20,  // fixed x as fraction of canvas width
  AVATAR_SIZE_MIN:       0.10,  // height as fraction of canvas height (full inhale)
  AVATAR_SIZE_MAX:       0.17,  // height as fraction of canvas height (full exhale)

  // ── Stress mechanic ───────────────────────────────────────────────────────
  AVATAR_STRESS_SIZE_MIN: 0.03,  // smallest avatar height (all misses)
  AVATAR_STRESS_SIZE_MAX: 0.26,  // largest avatar height (all collects)
  AVATAR_STRESS_INIT:    0.5,   // starting stress norm (0–1)
  STRESS_GROW_STEP:      0.06,  // norm added per collect
  STRESS_SHRINK_STEP:    0.04,  // norm removed per miss
  SPEED_GROW_STEP:       0.06,  // scroll-speed norm added per collect
  SPEED_SHRINK_STEP:     0.04,  // scroll-speed norm removed per miss
  SCROLL_SPEED_MIN:      0.07,  // min item scroll speed (canvas widths/sec)
  SCROLL_SPEED_MAX:      0.22,  // max item scroll speed
  SCROLL_SPEED_INIT:     0.5,   // starting speed norm (0–1)
  BG_SCROLL_FACTOR:      0.38,  // bg scroll speed = item speed × factor
  MISS_GAME_OVER:        20,    // total misses before game over

  // ── Items ─────────────────────────────────────────────────────────────────
  ITEM_SPAWN_MIN_MS:     1500,
  ITEM_SPAWN_MAX_MS:     3500,
  ITEM_SIZE_RATIO:       0.045, // size as fraction of canvas height
  ITEM_HIT_RADIUS:       0.12,  // normalised Y tolerance for collection

  // ── Background ───────────────────────────────────────────────────────────
  BG_TEX_WIDTH:          2048,  // offscreen texture width (seamlessly tiling)
  BG_TEX_HEIGHT:         512,

  // ── Data recording ───────────────────────────────────────────────────────
  FRAME_INTERVAL_MS:     50,    // 20 fps of frame data
  FRAME_FLUSH_COUNT:     400,   // flush after this many buffered rows
};

export const STATE = {
  IDLE:         'idle',
  CALIBRATING:  'calibrating',
  READY:        'ready',        // waiting for experimenter to start block
  COUNTDOWN:    'countdown',
  PLAYING:      'playing',
  INTERMISSION: 'intermission', // between block 1 and block 2
  DONE:         'done',
};
