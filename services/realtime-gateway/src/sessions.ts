/**
 * NOVA Realtime Gateway — Session management.
 *
 * Single source of truth for WebSocket session state.
 * All handlers import from this module; no handler maintains its own sessions map.
 */
import { WebSocket } from 'ws';
import type { VoiceSession, STTResponse } from '@nova/shared-types';
import { logger } from './utils/logger.js';

export interface ManagedSession {
 session: VoiceSession;
 ws: WebSocket;
 connectedAt: number;
 lastActivity: number;
}

const sessions = new Map<string, ManagedSession>();

/**
 * Hard cap on a session's transcript buffer — the single source of truth.
 *
 * `AudioHandlerOptions.maxTranscriptBufferSize` only overrides this per handler; it
 * is not a second default. Before this bound was enforced, every append copied the
 * entire buffer (`[...buffer, x]`), so a long call grew without limit and each
 * append paid an ever-larger copy (O(n^2) over the call). The buffer is now a
 * rolling window of the most recent entries: once full, the oldest entry is evicted
 * per append, which bounds both the memory held and the copy cost of each append.
 */
export const MAX_TRANSCRIPT_BUFFER_SIZE = 200;

/** Clamp a caller-supplied cap to a usable integer; never let it disable the bound. */
function resolveTranscriptCap(maxBufferSize: number | undefined): number {
 if (typeof maxBufferSize !== 'number' || !Number.isFinite(maxBufferSize)) {
  return MAX_TRANSCRIPT_BUFFER_SIZE;
 }
 return Math.max(1, Math.floor(maxBufferSize));
}

/**
 * Append to the rolling window, evicting the oldest entries past `cap`.
 *
 * Returns a fresh bounded array, so the caller never receives the unbounded
 * intermediate. `managed.session` is replaced rather than mutated in place, so a
 * reader holding the previous session object keeps a consistent snapshot.
 */
function appendToTranscriptBuffer(
 buffer: readonly STTResponse[],
 transcript: STTResponse,
 cap: number,
): STTResponse[] {
 if (buffer.length >= cap) {
  // Keep the newest (cap - 1) entries, then append the new one.
  return buffer.slice(buffer.length - cap + 1).concat(transcript);
 }
 return buffer.concat(transcript);
}

export function getSession(sid: string): ManagedSession | undefined {
 return sessions.get(sid);
}

export function registerSession(session: VoiceSession, ws: WebSocket): ManagedSession {
 const managed: ManagedSession = {
  session,
  ws,
  connectedAt: Date.now(),
  lastActivity: Date.now(),
 };
 sessions.set(session.sessionId, managed);
 logger.info({ sessionId: session.sessionId, userId: session.userId, provider: session.provider }, 'Session registered');
 return managed;
}

export function unregisterSession(sessionId: string): void {
 const managed = sessions.get(sessionId);
 if (managed) {
  logger.info({ sessionId, durationMs: Date.now() - managed.connectedAt }, 'Session unregistered');
  sessions.delete(sessionId);
 }
}

export function updateSession(
 sessionId: string,
 patch: Partial<Pick<VoiceSession, 'status' | 'transcriptBuffer' | 'audioLevel' | 'endedAt'>>
): VoiceSession | undefined {
 const managed = sessions.get(sessionId);
 if (!managed) return undefined;

 // A direct transcriptBuffer patch is subject to the same bound as an append, so
 // this path cannot park an unbounded buffer on a session either.
 const bounded = patch.transcriptBuffer === undefined
  ? patch
  : {
   ...patch,
   transcriptBuffer: patch.transcriptBuffer.slice(-resolveTranscriptCap(undefined)),
  };

 managed.session = {
  ...managed.session,
  ...bounded,
 };
 managed.lastActivity = Date.now();
 return managed.session;
}

export function addTranscript(
 sessionId: string,
 transcript: STTResponse,
 maxBufferSize: number = MAX_TRANSCRIPT_BUFFER_SIZE,
): STTResponse[] | undefined {
 const managed = sessions.get(sessionId);
 if (!managed) return undefined;

 const cap = resolveTranscriptCap(maxBufferSize);
 const updated = appendToTranscriptBuffer(managed.session.transcriptBuffer, transcript, cap);
 managed.session = { ...managed.session, transcriptBuffer: updated };
 managed.lastActivity = Date.now();
 return updated;
}

export function updateAudioLevel(sessionId: string, level: number): import('@nova/shared-types').AudioLevelData | undefined {
 const managed = sessions.get(sessionId);
 if (!managed) return undefined;

 const audioData: import('@nova/shared-types').AudioLevelData = {
  level,
  peak: Math.max(managed.session.audioLevel, level),
  rms: level,
  timestamp: Date.now(),
 };

 managed.session = { ...managed.session, audioLevel: level };
 managed.lastActivity = Date.now();
 return audioData;
}

export function getActiveSessionCount(): number {
 let count = 0;
 sessions.forEach((s) => { if (s.session.status === 'active') count++; });
 return count;
}

export function getAllSessions(): VoiceSession[] {
 return Array.from(sessions.values()).map((s) => s.session);
}

export function cleanupStale(maxIdleMs = 5 * 60 * 1000): string[] {
 const now = Date.now();
 const stale: string[] = [];
 sessions.forEach((managed, sessionId) => {
  if (now - managed.lastActivity > maxIdleMs) {
   stale.push(sessionId);
  }
 });
 for (const sessionId of stale) {
  unregisterSession(sessionId);
 }
 return stale;
}

export function endSession(sessionId: string): void {
 const managed = sessions.get(sessionId);
 if (managed) {
  managed.ws.close(1000, 'Session ended');
  unregisterSession(sessionId);
 }
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startCleanupTimer(intervalMs = 60_000): NodeJS.Timeout {
 if (cleanupTimer) return cleanupTimer;
 cleanupTimer = setInterval(() => {
  const removed = cleanupStale();
  if (removed.length > 0) {
   logger.info({ removedCount: removed.length, sessionIds: removed }, 'Cleaned up stale sessions');
  }
 }, intervalMs);
 return cleanupTimer;
}

export function stopCleanupTimer(): void {
 if (cleanupTimer) {
  clearInterval(cleanupTimer);
  cleanupTimer = null;
 }
}
