export const CONFIG = {
  // Subject / experiment
  SUBJECT_CODE: "TEST",

  // Signal scaling (matching MATLAB LOG_SCALING_SYNC path)
  LOG_SCALE_DEPTH: 500,
  BREATH_SCALE_BASE_LOG: 1.2,

  // Smoothing
  SMOOTH_WINDOW: 64,        // samples (matches smoothBreathRT.m windowSize)

  // Calibration
  CALIBRATION_SECS: 10,     // seconds to record before first trial

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

  // Data output base directory (relative to Electron app dir)
  DATA_DIR: "subjectData",
};

export const STATE = {
  IDLE: 'idle',
  CALIBRATING: 'calibrating',
  READY: 'ready',     // between trials — waiting for experimenter
  TRIAL: 'trial',
  ITI: 'iti',
  DONE: 'done',
};
