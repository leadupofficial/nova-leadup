'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
 children: ReactNode;
 fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
 error: Error | null;
}

/**
 * Client-side error boundary that catches render-time exceptions in child
 * components and surfaces a recoverable failure UI instead of a blank screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
 state: State = { error: null };

 static getDerivedStateFromError(error: Error): State {
 return { error };
 }

 componentDidCatch(error: Error, info: ErrorInfo): void {
 // eslint-disable-next-line no-console
 console.error('[admin] ErrorBoundary caught:', error, info.componentStack);
 }

 reset = (): void => {
 this.setState({ error: null });
 };

 render() {
 const { error } = this.state;
 if (!error) return this.props.children;
 if (this.props.fallback) return this.props.fallback(error, this.reset);
 return (
 <div
 role="alert"
 aria-live="assertive"
 style={{
 margin: '2rem auto',
 maxWidth: '640px',
 padding: '1.5rem',
 background: '#fff',
 border: '1px solid #fecaca',
 borderRadius: '8px',
 color: '#7f1d1d',
 }}
 >
 <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 700 }}>
 Something went wrong
 </h2>
 <p style={{ margin: '0 0 1rem', fontSize: '0.9rem' }}>
 {error.message || 'An unexpected error occurred while rendering this page.'}
 </p>
 <button
 type="button"
 onClick={this.reset}
 aria-label="Retry after error"
 style={{
 padding: '0.5rem 1rem',
 background: '#dc2626',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.85rem',
 cursor: 'pointer',
 fontWeight: 600,
 }}
 >
 Try again
 </button>
 </div>
 );
 }
}
