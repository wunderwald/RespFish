// Mirrors makeTrialData.m and the lr/sf/sa balanced-sequence logic.

import { CONFIG } from './config.js';

export function makeTrialParams(numTrials) {
  // Balanced pseudo-random boolean sequences in blocks of `blockSize`
  function balancedSeq(length, blockSize) {
    const out = [];
    while (out.length < length) {
      const block = [];
      for (let i = 0; i < blockSize; i++) block.push(i % 2 === 0);
      // Fisher-Yates shuffle
      for (let i = block.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [block[i], block[j]] = [block[j], block[i]];
      }
      out.push(...block);
    }
    return out.slice(0, length);
  }

  const lrSeq = balancedSeq(numTrials, 4);   // left/right
  const saSeq = balancedSeq(numTrials, 2);   // sync/async alternating
  const numAsync = Math.floor(numTrials / 2);
  const sfSeq = balancedSeq(numAsync, 4);    // slow/fast (async only)
  const flashSeq = CONFIG.FLASHING_IMAGE
    ? balancedSeq(numTrials, 2)                 // 50% of trials get a flash
    : null;

  const trials = [];
  let asyncIdx = 0;

  for (let i = 0; i < numTrials; i++) {
    const sync = saSeq[i];
    const iti = CONFIG.ITI_MIN +
      Math.round(Math.random() * (CONFIG.ITI_MAX - CONFIG.ITI_MIN));

    const trial = {
      trialIndex: i + 1,
      synchronous: sync,
      img: 'cloud',  // CSV field — no image file used
      lr: lrSeq[i], // true = left, false = right
      ITI: iti,      // ms
      slowfast: null,     // only set for async trials
      flashImage: null,     // image name, or null if no flash this trial
      flashTime: null,     // seconds into trial when flash fires
      flashX: null,     // normalized [0, 1] horizontal position
      flashY: null,     // normalized [0, 1] vertical position
      startTime: null,
      endTime: null,
    };

    if (!sync) {
      trial.slowfast = sfSeq[asyncIdx % sfSeq.length]; // true = slow
      asyncIdx++;
    }

    if (CONFIG.FLASHING_IMAGE && flashSeq[i]) {
      trial.flashImage = CONFIG.FLASH_IMAGE;
      const flashMax = Math.min(
        CONFIG.FLASH_TIME_MAX,
        CONFIG.MAX_TRIAL_TIME - CONFIG.FLASH_DURATION / 1000
      );
      trial.flashTime = +(CONFIG.FLASH_TIME_MIN +
        Math.random() * (flashMax - CONFIG.FLASH_TIME_MIN)).toFixed(2);
      trial.flashX = +Math.random().toFixed(4);
      trial.flashY = +Math.random().toFixed(4);
    }

    trials.push(trial);
  }
  return trials;
}
