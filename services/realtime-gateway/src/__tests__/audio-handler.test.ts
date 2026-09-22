/**
 * @nova/realtime-gateway — audio handler transcript cap wiring (P-04).
 *
 * `AudioHandlerOptions.maxTranscriptBufferSize` was declared and never read. These
 * tests pin the wiring: the handler passes the caller's cap through to
 * `addTranscript`, and falls back to the single named constant when none is given.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import type { VoiceSession } from '@nova/shared-types';

vi.mock('../utils/logger.js', () => ({
 logger: {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
 },
}));

import { setupAudioHandler } from '../handlers/audio.js';
import {
 MAX_TRANSCRIPT_BUFFER_SIZE,
 getSession,
 registerSession,
 unregisterSession,
} from '../sessions.js';

interface WsHarness {
 ws: WebSocket;
 emit: (event: string) => void;
}

function makeWs(onMessage?: (data: Buffer) => void): WsHarness {
 const handlers = new Map<string, (...args: any[]) => void>();
 const ws = {
  on: (event: string, cb: (...args: any[]) => void) => {
   handlers.set(event, cb);
  },
  send: () => undefined,
  close: () => undefined,
 } as unknown as WebSocket;

 if (onMessage) handlers.set('message', onMessage);
 return { ws, emit: (event: string) => handlers.get(event)?.() };
}

function makeSession(sessionId: string, audioLevel = 0): VoiceSession {
 return {
  sessionId,
  userId: 'user-1',
  provider: 'sarvam',
  config: {} as VoiceSession['config'],
  status: 'active',
  transcriptBuffer: [],
  audioLevel,
  startedAt: new Date(),
 };
}

/**
 * The handler's flush closure reads `session.audioLevel` from the object it was
 * handed, so a session constructed already above the 0.1 threshold exercises the
 * flush path deterministically.
 */
const AUDIBLE = 0.5;

describe('setupAudioHandler transcript cap', () => {
 const registered: string[] = [];

 beforeEach(() => {
  vi.useFakeTimers();
 });

 afterEach(() => {
  vi.useRealTimers();
  while (registered.length) unregisterSession(registered.pop()!);
 });

 function start(sessionId: string, opts?: { maxTranscriptBufferSize?: number }) {
  const session = makeSession(sessionId, AUDIBLE);
  const { ws } = makeWs();
  registerSession(session, ws);
  registered.push(sessionId);
  setupAudioHandler(ws, session, opts);
  return session;
 }

 it('honours the declared maxTranscriptBufferSize option', () => {
  start('s-audio-capped', { maxTranscriptBufferSize: 3 });

  for (let i = 0; i < 20; i++) vi.advanceTimersByTime(5000);

  const managed = getSession('s-audio-capped');
  expect(managed).toBeDefined();
  expect(managed!.session.transcriptBuffer.length).toBe(3);
 });

 it('defaults to the single named constant when no option is given', () => {
  start('s-audio-default');

  const ticks = MAX_TRANSCRIPT_BUFFER_SIZE + 25;
  for (let i = 0; i < ticks; i++) vi.advanceTimersByTime(5000);

  const managed = getSession('s-audio-default');
  expect(managed).toBeDefined();
  expect(managed!.session.transcriptBuffer.length).toBe(MAX_TRANSCRIPT_BUFFER_SIZE);
 });
});
