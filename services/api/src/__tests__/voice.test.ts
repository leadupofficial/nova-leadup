/**
 * NOVA API — Voice routes tests.
 *
 * Covers: POST /api/v1/voice/stt, POST /api/v1/voice/tts
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import './setup.js';
import app from '../server.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

function createToken(payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' }): string {
 return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
 return { Authorization: `Bearer ${token}` };
}

// ─── POST /api/v1/voice/stt ────────────────────────────────────────

describe('POST /api/v1/voice/stt', () => {
 it('returns 400 for an invalid audioData', async () => {
 const res = await request(app)
 .post('/api/v1/voice/stt')
 .set(authHeader(createToken()))
 .send({ audioData: 'not-a-url' });
 expect(res.status).toBe(400);
 expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
 });

 it('returns 401 without an auth token', async () => {
 const res = await request(app).post('/api/v1/voice/stt').send({ audioData: 'https://example.com/audio.mp3' });
 expect(res.status).toBe(401);
 expect(res.body).toHaveProperty('code', 'UNAUTHORIZED');
 });

 it('returns 200 for a valid transcription request', async () => {
 const res = await request(app)
 .post('/api/v1/voice/stt')
 .set(authHeader(createToken()))
 .send({ audioData: Buffer.from('audio') });
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('success', true);
 expect(res.body.data).toHaveProperty('text');
 });

 it('returns 200 when optional language is provided', async () => {
 const res = await request(app)
 .post('/api/v1/voice/stt')
 .set(authHeader(createToken()))
 .send({ audioData: Buffer.from('audio'), language: 'en-IN' });
 expect(res.status).toBe(200);
 expect(res.body.data).toHaveProperty('text');
 });
});

// ─── POST /api/v1/voice/tts ────────────────────────────────────────

describe('POST /api/v1/voice/tts', () => {
 it('returns 400 for an empty text field', async () => {
 const res = await request(app)
 .post('/api/v1/voice/tts')
 .set(authHeader(createToken()))
 .send({ text: '' });
 expect(res.status).toBe(400);
 expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
 });

 it('returns 401 without an auth token', async () => {
 const res = await request(app).post('/api/v1/voice/tts').send({ text: 'Hello' });
 expect(res.status).toBe(401);
 expect(res.body).toHaveProperty('code', 'UNAUTHORIZED');
 });

 it('returns 200 for a valid tts request with default voice', async () => {
 const res = await request(app)
 .post('/api/v1/voice/tts')
 .set(authHeader(createToken()))
 .send({ text: 'Hello from NOVA' });
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('success', true);
 expect(res.body.data).toHaveProperty('audioData');
 });

 it('returns 200 with the specified voice when provided', async () => {
 const res = await request(app)
 .post('/api/v1/voice/tts')
 .set(authHeader(createToken()))
 .send({ text: 'Hello from NOVA', voiceId: 'nova-voice' });
 expect(res.status).toBe(200);
 expect(res.body.data).toHaveProperty('voiceId', 'nova-voice');
 });

 it('returns 400 when body is empty', async () => {
 const res = await request(app).post('/api/v1/voice/tts').set(authHeader(createToken())).send({});
 expect(res.status).toBe(400);
 expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
 });
});
