/**
 * NOVA API — Chat routes tests.
 *
 * Covers: POST /message, GET /history/:sessionId, DELETE /history/:sessionId
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import request from 'supertest';
import './setup';

import app from '../server.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

function createToken(
 payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' },
): string {
 return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(token: string): Record<string, string> {
 return { Authorization: `Bearer ${token}` };
}

const VALID_SESSION_ID = uuidv4();

describe('POST /api/v1/chat/message', () => {
 it('returns 400 when sessionId is missing', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 content: 'hello',
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when sessionId is not a valid UUID', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: 'not-uuid',
 content: 'hello',
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content is empty', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: '',
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content is missing', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content exceeds 10 000 characters', async () => {
 const longContent = 'a'.repeat;
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: longContent,
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content contains a SQL injection payload', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: "'; DROP TABLE messages; --",
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content contains an XSS payload', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: '<script>alert("xss")</script>',
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when sessionId contains a SQL injection payload', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: "'; DROP TABLE chat_sessions; --",
 content: 'hello',
 });
 expect(res.status).toBe(400);
 });

 it('returns 400 when content is null', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: null,
 });
 expect(res.status).toBe(400);
 });

 it('returns 200 with a valid auth token and valid body', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: 'Hello from NOVA',
 });
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('success', true);
 expect(res.body).toHaveProperty('data');
 });

 it('returns 200 when optional metadata is included', async () => {
 const res = await request(app).post('/api/v1/chat/message').set(authHeader(createToken())).send({
 sessionId: VALID_SESSION_ID,
 content: 'Hello with metadata',
 metadata: { source: 'test' },
 });
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('success', true);
 });
});

describe('GET /api/v1/chat/history/:sessionId', () => {
 it('returns 401 without an auth token', async () => {
 const res = await request(app).get(`/api/v1/chat/history/${VALID_SESSION_ID}`);
 expect(res.status).toBe(401);
 });

 it('returns 200 with an empty messages array for a valid session', async () => {
 const res = await request(app)
 .get(`/api/v1/chat/history/${VALID_SESSION_ID}`)
 .set(authHeader(createToken()));
 expect(res.status).toBe(200);
 expect(res.body).toHaveProperty('success', true);
 expect(res.body).toHaveProperty('data');
 });
});

describe('DELETE /api/v1/chat/history/:sessionId', () => {
 it('returns 401 without an auth token', async () => {
 const res = await request(app).delete(`/api/v1/chat/history/${VALID_SESSION_ID}`);
 expect(res.status).toBe(401);
 });

 it('returns 204 with a valid auth token', async () => {
 const res = await request(app)
 .delete(`/api/v1/chat/history/${VALID_SESSION_ID}`)
 .set(authHeader(createToken()));
 expect(res.status).toBe(204);
 });
});
