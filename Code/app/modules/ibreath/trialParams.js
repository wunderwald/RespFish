// Mirrors makeTrialData.m and the lr/sf/sa balanced-sequence logic.

import { CONFIG } from './config.js';

export function makeTrialParams(numTrials, group = 'target') {
  // Balanced pseudo-random boolean sequence.
  // Each block of `blockSize` contains exactly `trueCount` true values (default 50%).
  function balancedSeq(length, blockSize, trueCount = Math.floor(blockSize / 2)) {
    const out = [];
    while (out.length < length) {
      const block = Array.from({ length: blockSize }, (_, i) => i < trueCount);
      for (let i = block.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [block[i], block[j]] = [block[j], block[i]];
      }
      out.push(...block);
    }
    return out.slice(0, length);
  }

  // Question sequence: 50% main question for the group, ~16.7% each of the other three.
  // Built from shuffled 6-trial blocks: [main×3, other1, other2, other3].
  function makeQuestionSeq(n) {
    const main   = group === 'control' ? 'flash' : 'sync';
    const others = group === 'control' ? ['sync', 'lr', 'img'] : ['flash', 'lr', 'img'];
    const template = [main, main, main, ...others];
    const out = [];
    while (out.length < n) {
      const block = [...template];
      for (let i = block.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [block[i], block[j]] = [block[j], block[i]];
      }
      out.push(...block);
    }
    return out.slice(0, n);
  }

  const lrSeq       = balancedSeq(numTrials, 4);     // left / right
  const saSeq       = balancedSeq(numTrials, 2);     // sync / async alternating
  const numAsync    = Math.floor(numTrials / 2);
  const sfSeq       = balancedSeq(numAsync,  4);     // slow / fast (async only)
  const starfishSeq = balancedSeq(numTrials, 4, 1);  // 25% starfish, 75% pufferfish
  const flashSeq    = CONFIG.FLASHING_IMAGE
    ? balancedSeq(numTrials, 2)                      // 50% of trials get a flash
    : null;
  const questionSeq = makeQuestionSeq(numTrials);

  const trials = [];
  let asyncIdx = 0;

  for (let i = 0; i < numTrials; i++) {
    const sync = saSeq[i];
    const iti = CONFIG.ITI_MIN +
      Math.round(Math.random() * (CONFIG.ITI_MAX - CONFIG.ITI_MIN));

    const trial = {
      trialIndex:   i + 1,
      synchronous:  sync,
      img:          starfishSeq[i] ? 'starfish' : 'pufferfish',
      lr:           lrSeq[i],          // true = left, false = right
      stimX0:       lrSeq[i] ? 0 : 0.5,
      stimY0:       0,
      stimX1:       lrSeq[i] ? 0.5 : 1,
      stimY1:       1,
      ITI:          iti,               // ms
      questionType: questionSeq[i],    // 'sync' | 'flash' | 'lr' | 'img'
      slowfast:     null,              // only set for async trials
      flashImage:   null,              // image name, or null if no flash this trial
      flashTime:    null,              // seconds into trial when flash fires
      flashX:       null,              // normalised [0,1] horizontal position
      flashY:       null,              // normalised [0,1] vertical position
      startTime:    null,
      endTime:      null,
    };

    if (!sync) {
      trial.slowfast = sfSeq[asyncIdx % sfSeq.length];
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
