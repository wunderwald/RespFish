export const CONFIG = {
  // Subject / experiment
  SUBJECT_CODE: "TEST",

  // Signal scaling (matching MATLAB LOG_SCALING_SYNC path)
  LOG_SCALE_DEPTH: 500,
  BREATH_SCALE_BASE_LOG: 1.2,

  // Smoothing
  SMOOTH_WINDOW: 64,        // samples (matches smoothBreathRT.m windowSize)

  // Calibration
  CALIBRATION_SECS: 30,     // seconds to record before first trial

  // TODO: measure real min/max from pilot recordings and replace these placeholders
  DEFAULT_CAL_RANGE: [0.2, 0.8],  // used if the experimenter chooses "use default" after a failed calibration

  // Trial timing
  MAX_NUM_TRIALS: 80,
  MAX_TRIAL_TIME: 30,       // seconds
  MIN_TRIAL_TIME: 5,       // seconds
  ITI_MIN: 2000,       // ms
  ITI_MAX: 3000,       // ms

  // Async signal
  SPEED_FACTOR_SLOW: 1.1,
  SPEED_FACTOR_FAST: 0.9,

  // Noise
  ADD_NOISE_ASYNC: true,
  MAP_ASYNC_RANGE_TO_SYNC_RANGE: true,

  // Cloud stimulus size (fraction of the shorter half-scene dimension)
  CLOUD_SIZE_MIN: 0.10,     // at stimulusLevel = 0
  CLOUD_SIZE_MAX: 0.45,     // at stimulusLevel = 1

  // Data output base directory (relative to Electron app dir) — do not change
  DATA_DIR: "output_data/ibreath",

  // Questions after trials
  SHOW_QUESTIONS: true,      // show a post-trial response question after each trial
  RESPONSE_TIMEOUT_SECS: 5,        // seconds before a non-response is recorded as 'timeout'

  // Flash image
  FLASHING_IMAGE: true,         // show a flash image in 50% of trials
  FLASH_IMAGE: 'pinkfish',   // image name — label for CSV and draw-routine selector
  FLASH_DURATION: 250,          // ms the flash is visible
  FLASH_TIME_MIN: 5,            // earliest flash onset (seconds into trial)
  FLASH_TIME_MAX: 20,           // latest flash onset (seconds into trial)

  // Animation display (pre-trial animation)
  ANIMATION_DISPLAY: true, // show animated display between ITI/READY and trial
  DISPLAY_SECS: 5,         // seconds to show the animated display before each trial

  // Gaze input (optional LSL stream via second bridge)
  GAZE_STREAM_URL: 'ws://localhost:8766',
  DEBUG_GAZE: false,      // overlay a dot at the current gaze position

  // Marker output (LSL via WebSocket)
  SEND_MARKERS: true,
  MARKER_STREAM_URL: 'ws://localhost:9001',

  // Experiment control
  AUTO_ADVANCE: true,      // skip the READY state — advance to next trial automatically
};

export const STATE = {
  IDLE: 'idle',
  CALIBRATING: 'calibrating',
  READY: 'ready',      // between trials — waiting for experimenter
  DISPLAY: 'display',  // 5-second pre-trial animation
  TRIAL: 'trial',
  RESPONSE: 'response',   // post-trial question (SHOW_QUESTIONS only)
  ITI: 'iti',
  PAUSED: 'paused',    // experimenter paused mid-experiment
  DONE: 'done',
};
