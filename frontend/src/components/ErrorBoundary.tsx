import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Button from './ui/Button';

interface Props {
 children: ReactNode;
 fallback?: ReactNode;
}

interface State {
 hasError: boolean;
 error: Error | null;
}

/**
 * Error Boundary component to catch JavaScript errors anywhere in the component tree
 * and display a fallback UI instead of crashing the entire app
 */
export class ErrorBoundary extends Component<Props, State> {
 public state: State = {
 hasError: false,
 error: null,
 };

 public static getDerivedStateFromError(error: Error): State {
 return { hasError: true, error };
 }

 public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
 // Log error to logging service
 console.error('ErrorBoundary caught an error:', error, errorInfo);

 // In production, send to error tracking service (e.g., Sentry)
 if (import.meta.env.PROD) {
 // TODO: Send to error tracking service
 // Sentry.captureException(error, { contexts: { react: errorInfo } });
 }
 }

 private handleReset = () => {
 this.setState({ hasError: false, error: null });
 };

 public render() {
 if (this.state.hasError) {
 // Custom fallback UI
 if (this.props.fallback) {
 return this.props.fallback;
 }

 return (
 <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
 <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
 <div className="flex items-center justify-center w-12 h-12 mx-auto bg-red-100 dark:bg-red-900 rounded-full">
 <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
 </div>

 <h2 className="mt-4 text-2xl font-bold text-center text-gray-900 dark:text-white">
 Something went wrong
 </h2>

 <p className="mt-2 text-center text-gray-600 dark:text-gray-400">
 We're sorry, but something unexpected happened. Please try again.
 </p>

 {import.meta.env.DEV && this.state.error && (
 <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
 <p className="text-sm text-red-800 dark:text-red-200 font-mono break-all">
 {this.state.error.message}
 </p>
 </div>
 )}

 <div className="mt-6 flex gap-3">
 <Button
 onClick={this.handleReset}
 className="flex-1"
 variant="primary"
 >
 <RefreshCw className="w-4 h-4 mr-2" />
 Try Again
 </Button>

 <Button
 onClick={() => window.location.href = '/'}
 className="flex-1"
 variant="secondary"
 >
 Go Home
 </Button>
 </div>
 </div>
 </div>
 );
 }

 return this.props.children;
 }
}
