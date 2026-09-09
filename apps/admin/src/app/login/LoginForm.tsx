'use client';

import { type FormEvent, useState } from 'react';
import { adminLogin } from '../../lib/api';
import { clearTokens } from '../../components/AdminAuthGuard';

type FormState = 'idle' | 'loading' | 'error' | 'success';

export default function LoginForm() {
 const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 const [state, setState] = useState<FormState>('idle');
 const [error, setError] = useState<string | null>(null);

 const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
 e.preventDefault();
 setError(null);
 setState('loading');
 try {
 const result = await adminLogin({ email, password });
 if (typeof window !== 'undefined' && result?.accessToken) {
 window.localStorage.setItem('admin_token', result.accessToken);
 if (result.refreshToken) {
 window.localStorage.setItem('admin_refresh_token', result.refreshToken);
 }
 // Mirror token into cookie so middleware can read it at the edge
 document.cookie = `admin_token=${result.accessToken}; path=/; max-age=31536000; SameSite=Lax`;
 }
 setState('success');
 window.location.href = '/';
 } catch (err) {
 const message = err instanceof Error ? err.message : 'Login failed. Please try again.';
 setError(message);
 setState('error');
 }
 };

 if (state === 'success') {
 return (
 <p style={{ color: '#10b981', fontSize: '0.9rem' }}>
 Redirecting...
 </p>
 );
 }

 return (
 <form
 onSubmit={handleSubmit}
 aria-label="Admin login form"
 style={{
 width: '100%',
 maxWidth: '400px',
 background: '#131c31',
 border: '1px solid #1a2340',
 borderRadius: '12px',
 padding: '2rem',
 boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
 }}
 noValidate
 >
 <h1
 style={{
 margin: '0 0 0.25rem',
 fontSize: '1.5rem',
 fontWeight: 700,
 color: '#f8fafc',
 }}
 >
 Admin Sign In
 </h1>
 <p
 style={{
 margin: '0 0 1.5rem',
 fontSize: '0.85rem',
 color: '#94a3b8',
 }}
 >
 Sign in to access the NOVA platform admin console.
 </p>

 <label
 htmlFor="email"
 style={{
 display: 'block',
 fontSize: '0.8rem',
 fontWeight: 500,
 color: '#94a3b8',
 marginBottom: '0.35rem',
 }}
 >
 Email address
 </label>
 <input
 id="email"
 name="email"
 type="email"
 autoComplete="email"
 required
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 disabled={state === 'loading'}
 placeholder="admin@example.com"
 aria-label="Email address"
 style={{
 width: '100%',
 padding: '0.65rem 0.85rem',
 background: '#0a0e1a',
 border: '1px solid #1a2340',
 borderRadius: '6px',
 color: '#f8fafc',
 fontSize: '0.9rem',
 marginBottom: '1rem',
 outline: 'none',
 boxSizing: 'border-box',
 }}
 />

 <label
 htmlFor="password"
 style={{
 display: 'block',
 fontSize: '0.8rem',
 fontWeight: 500,
 color: '#94a3b8',
 marginBottom: '0.35rem',
 }}
 >
 Password
 </label>
 <input
 id="password"
 name="password"
 type="password"
 autoComplete="current-password"
 required
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 disabled={state === 'loading'}
 placeholder="••••••••"
 aria-label="Password"
 style={{
 width: '100%',
 padding: '0.65rem 0.85rem',
 background: '#0a0e1a',
 border: '1px solid #1a2340',
 borderRadius: '6px',
 color: '#f8fafc',
 fontSize: '0.9rem',
 marginBottom: '1rem',
 outline: 'none',
 boxSizing: 'border-box',
 }}
 />

 {state === 'error' && error && (
 <div
 role="alert"
 aria-live="polite"
 style={{
 padding: '0.75rem 1rem',
 background: '#450a0a',
 border: '1px solid #7f1d1d',
 borderRadius: '6px',
 color: '#fecaca',
 fontSize: '0.85rem',
 marginBottom: '1rem',
 }}
 >
 {error}
 </div>
 )}

 <button
 type="submit"
 disabled={state === 'loading'}
 aria-label="Sign in to admin console"
 style={{
 width: '100%',
 padding: '0.65rem',
 background: '#6366f1',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.9rem',
 fontWeight: 600,
 cursor: state === 'loading' ? 'not-allowed' : 'pointer',
 opacity: state === 'loading' ? 0.7 : 1,
 boxSizing: 'border-box',
 }}
 >
 {state === 'loading' ? 'Signing in…' : 'Sign In'}
 </button>
 </form>
 );
}
