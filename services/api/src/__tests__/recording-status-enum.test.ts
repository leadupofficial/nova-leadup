import { describe, it, expect } from 'vitest';
import { UpdateRecordingSchema } from '../schemas/index.js';
import { RECORDING_STATUS } from '../services/recording-pipeline.js';

describe('the recording status enum', () => {
  it('accepts every status the pipeline can write', () => {
    // The gap this guards: an enum narrower than the constant silently rejects a status
    // the app legitimately sends — the first version of this omitted 'recording' and
    // 'uploaded'.
    for (const value of Object.values(RECORDING_STATUS)) {
      expect(UpdateRecordingSchema.safeParse({ status: value }).success).toBe(true);
    }
    expect(Object.values(RECORDING_STATUS)).toHaveLength(5);
  });

  it('rejects a status no reader recognises', () => {
    expect(UpdateRecordingSchema.safeParse({ status: 'totally-made-up' }).success).toBe(false);
  });
});
