import type { WebSocket } from 'ws';
import type { VoiceSession } from '@nova/shared-types';
import { logger } from '../utils/logger.js';
import { addTranscript } from '../sessions.js';

export interface TextHandlerOptions {
 maxMessageLength?: number;
}

/**
 * Sets up text message handling on a WebSocket connection.
 *
 * Handles: chat messages, commands, session control via text protocol.
 */
export function setupTextHandler(
 ws: WebSocket,
 session: VoiceSession,
 _opts: TextHandlerOptions = {}
): void {
 ws.on('message', (data: Buffer) => {
 const raw = data.toString('utf-8');
 if (raw.length > (_opts.maxMessageLength ?? 4096)) {
 ws.send(JSON.stringify({ type: 'error', data: { message: 'Message too long' } }));
 return;
 }

 let parsed: { type: string; data?: Record<string, unknown> };
 try {
 parsed = JSON.parse(raw);
 } catch {
 ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid JSON' } }));
 return;
 }

 switch (parsed.type) {
 case 'text':
 handleTextMessage(ws, session, parsed.data);
 break;
 case 'command':
 handleCommand(ws, session, parsed.data);
 break;
 case 'end_session':
 handleEndSession(ws, session);
 break;
 default:
 ws.send(JSON.stringify({ type: 'error', data: { message: `Unknown type: ${parsed.type}` } }));
 }
 });
}

function handleTextMessage(ws: WebSocket, session: VoiceSession, data?: Record<string, unknown>): void {
 const text = typeof data?.text === 'string' ? data.text : '';
 if (!text.trim()) {
 ws.send(JSON.stringify({ type: 'error', data: { message: 'Empty text' } }));
 return;
 }

 // Store as transcript entry. `STTResponse` requires `transcript` and
 // `language`; the legacy `text` / `timestamp` fields are kept so the stored
 // buffer entry keeps its shape.
 const transcriptEntry = {
 transcript: text,
 text,
 isFinal: true,
 confidence: 1.0,
 language: session.config.language ?? 'en',
 timestamp: Date.now(),
 };
 void addTranscript(session.sessionId, transcriptEntry);

 // Echo back as transcript
 ws.send(JSON.stringify({
 type: 'transcript',
 data: { text, isFinal: true, confidence: 1.0, timestamp: Date.now() },
 }));
}

function handleCommand(ws: WebSocket, session: VoiceSession, data?: Record<string, unknown>): void {
 const command = typeof data?.command === 'string' ? data.command : '';
 logger.info({ sessionId: session.sessionId, command }, 'Command received');

 switch (command) {
 case 'ping':
 ws.send(JSON.stringify({ type: 'pong', data: { timestamp: Date.now() } }));
 break;
 case 'status':
 ws.send(JSON.stringify({
 type: 'status',
 data: { sessionId: session.sessionId, status: session.status, provider: session.provider },
 }));
 break;
 default:
 ws.send(JSON.stringify({ type: 'error', data: { message: `Unknown command: ${command}` } }));
 }
}

function handleEndSession(ws: WebSocket, session: VoiceSession): void {
 logger.info({ sessionId: session.sessionId }, 'End session requested via text');
 ws.send(JSON.stringify({ type: 'session_ended', data: { sessionId: session.sessionId } }));
 ws.close(1000, 'Session ended by client');
}
