/**
 * @nova/realtime-gateway — transcript buffer bound (P-04).
 *
 * `AudioHandlerOptions.maxTranscriptBufferSize` used to be declared and never read:
 * `addTranscript` appended with a copy-on-write spread forever, so a long call grew
 * the buffer without limit and paid an ever-growing copy on every append.
 *
 * These tests push well past the cap and assert the buffer stays bounded and keeps
 * the most recent entries (rolling window), never the oldest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import type { STTResponse, VoiceSession } from '@nova/shared-types';

vi.mock('../utils/logger.js', () => ({
 logger: {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
 },
}));

import {
 addTranscript,
 registerSession,
 unregisterSession,
 MAX_TRANSCRIPT_BUFFER_SIZE,
} from '../sessions.js';

function makeSession(sessionId: string): VoiceSession {
 return {
  sessionId,
  userId: 'user-1',
  provider: 'sarvam',
  config: {} as VoiceSession['config'],
  status: 'active',
  transcriptBuffer: [],
  audioLevel: 0,
  startedAt: new Date(),
 };
}

function makeWs(): WebSocket {
 return { close: vi.fn(), send: vi.fn() } as unknown as WebSocket;
}

function makeTranscript(n: number): STTResponse {
 return { transcript: `utterance-${n}`, isFinal: true, confidence: 1, language: 'en' };
}

describe('addTranscript buffer bound', () => {
 beforeEach(() => {
  unregisterSession('s-bounded');
  unregisterSession('s-eviction');
  unregisterSession('s-custom');
 });

 it('exposes a single named cap constant', () => {
  expect(typeof MAX_TRANSCRIPT_BUFFER_SIZE).toBe('number');
  expect(MAX_TRANSCRIPT_BUFFER_SIZE).toBeGreaterThan(0);
 });

 it('stays bounded when pushed well past the cap', () => {
  registerSession(makeSession('s-bounded'), makeWs());

  const overflow = MAX_TRANSCRIPT_BUFFER_SIZE * 3;
  let returned: STTResponse[] | undefined;
  for (let i = 0; i < overflow; i++) {
   returned = addTranscript('s-bounded', makeTranscript(i));
  }

  // The value handed back to the caller must be bounded too — returning the
  // unbounded intermediate would leak the same growth to the handler.
  expect(returned).toBeDefined();
  expect(returned!.length).toBe(MAX_TRANSCRIPT_BUFFER_SIZE);
 });

 it('drops the oldest entries and keeps the most recent window', () => {
  registerSession(makeSession('s-eviction'), makeWs());

  const cap = MAX_TRANSCRIPT_BUFFER_SIZE;
  const overflow = cap * 2 + 7;
  for (let i = 0; i < overflow; i++) {
   addTranscript('s-eviction', makeTranscript(i));
  }

  const buffer = addTranscript('s-eviction', makeTranscript(overflow))!;
  const newest = overflow;

  expect(buffer.length).toBe(cap);
  // Newest entry is retained.
  expect(buffer[buffer.length - 1].transcript).toBe(`utterance-${newest}`);
  // The window is exactly the newest `cap` entries, in order.
  expect(buffer.map((t) => t.transcript)).toEqual(
   Array.from({ length: cap }, (_, k) => `utterance-${newest - cap + 1 + k}`),
  );
  // Oldest entries were evicted, not merely hidden.
  expect(buffer.some((t) => t.transcript === 'utterance-0')).toBe(false);
  expect(buffer.some((t) => t.transcript === `utterance-${newest - cap}`)).toBe(false);
 });

 it('honours an explicit caller-supplied cap', () => {
  registerSession(makeSession('s-custom'), makeWs());

  for (let i = 0; i < 10; i++) {
   addTranscript('s-custom', makeTranscript(i), 3);
  }

  const buffer = addTranscript('s-custom', makeTranscript(10), 3)!;
  expect(buffer.length).toBe(3);
  expect(buffer.map((t) => t.transcript)).toEqual([
   'utterance-8',
   'utterance-9',
   'utterance-10',
  ]);
 });
});
