'use client';

import { type FormEvent, useState } from 'react';
import { adminLogin, MfaInvalidError, MfaRequiredError, writeTokens } from '../../lib/api';

type FormState = 'idle' | 'loading' | 'error' | 'success';

export default function LoginForm() {
 const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 // Revealed only once the API says this account has a second factor. Showing it always would train
 // operators to ignore a field that does nothing for most of them.
 const [mfaCode, setMfaCode] = useState('');
 const [mfaRequired, setMfaRequired] = useState(false);
 const [state, setState] = useState<FormState>('idle');
 const [error, setError] = useState<string | null>(null);

 const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
 e.preventDefault();
 setError(null);
 setState('loading');
 try {
 const result = await adminLogin({ email, password, mfaCode: mfaCode || undefined });
 if (result?.accessToken) {
 // One writer for localStorage and the edge-readable cookie. This block used to
 // assign `document.cookie` itself, for a year and without `Secure`, which
 // contradicted the 1-hour/Secure policy documented in `lib/api.ts` and left the
 // sign-in cookie outliving the token it carried by 364 days.
 writeTokens(result.accessToken, result.refreshToken);
 }
 setState('success');
 window.location.href = '/';
 } catch (err) {
 // A required-but-missing factor is not a failure to report and retype: it is the next step.
 if (err instanceof MfaRequiredError) {
 setMfaRequired(true);
 setError(null);
 setState('idle');
 return;
 }
 if (err instanceof MfaInvalidError) {
 setMfaRequired(true);
 setError(err.message);
 setState('error');
 setMfaCode('');
 return;
 }
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

 {mfaRequired && (
 <>
 <label
 htmlFor="mfaCode"
 style={{
 display: 'block',
 fontSize: '0.8rem',
 fontWeight: 500,
 color: '#94a3b8',
 marginBottom: '0.35rem',
 }}
 >
 Verification code
 </label>
 <input
 id="mfaCode"
 name="mfaCode"
 type="text"
 inputMode="numeric"
 autoComplete="one-time-code"
 // Focused on appearance: the operator has just been told a code is needed, and making them
 // click the field is the kind of small friction that gets a security control disabled.
 autoFocus
 required
 value={mfaCode}
 onChange={(e) => setMfaCode(e.target.value)}
 disabled={state === 'loading'}
 placeholder="123456 or ABCD-EFGH-JKLM"
 aria-label="Two-factor verification code"
 style={{
 width: '100%',
 padding: '0.65rem 0.85rem',
 background: '#0a0e1a',
 border: '1px solid #1a2340',
 borderRadius: '6px',
 color: '#f8fafc',
 fontSize: '0.9rem',
 marginBottom: '0.5rem',
 outline: 'none',
 boxSizing: 'border-box',
 letterSpacing: '0.08em',
 }}
 />
 <p style={{ fontSize: '0.7rem', color: '#64748b', margin: '0 0 1rem' }}>
 Code from your authenticator app, or one of your recovery codes. Each code works once.
 </p>
 </>
 )}

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
