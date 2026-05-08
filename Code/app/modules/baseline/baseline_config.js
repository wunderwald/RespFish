export const CONFIG = {
  DURATION_SECS:     300,   // 5 minutes
  SUBJECT_CODE:      'TEST',
  DATA_DIR:          'output_data/baseline', // do not change

  SEND_MARKERS:      true,
  MARKER_STREAM_URL: 'ws://localhost:9001',
};

export const STATE = {
  IDLE:    'idle',
  PLAYING: 'playing',
  DONE:    'done',
};
