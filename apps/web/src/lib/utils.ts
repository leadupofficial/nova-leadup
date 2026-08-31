import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
 return clsx(inputs);
}

export function formatTime(date: Date | number): string {
 const d = date instanceof Date ? date : new Date(date);
 return d.toLocaleTimeString('en-US', {
 hour: 'numeric',
 minute: '2-digit',
 hour12: true,
 });
}

export function formatDuration(seconds: number): string {
 const mins = Math.floor(seconds / 60);
 const secs = seconds % 60;
 if (mins === 0) return `${secs}s`;
 if (secs === 0) return `${mins}m`;
 return `${mins}m ${secs}s`;
}

export function formatRelativeTime(date: Date | number): string {
 const d = date instanceof Date ? date : new Date(date);
 const now = new Date();
 const diffMs = now.getTime() - d.getTime();
 const diffSecs = Math.floor(diffMs / 1000);
 const diffMins = Math.floor(diffSecs / 60);
 const diffHours = Math.floor(diffMins / 60);
 const diffDays = Math.floor(diffHours / 24);

 if (diffSecs < 60) return 'Just now';
 if (diffMins < 60) return `${diffMins}m ago`;
 if (diffHours < 24) return `${diffHours}h ago`;
 if (diffDays < 7) return `${diffDays}d ago`;
 return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function generateId(prefix = 'id'): string {
 return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function debounce<T extends (...args: unknown[]) => void>(
 fn: T,
 delay: number
): (...args: Parameters<T>) => void {
 let timeout: ReturnType<typeof setTimeout>;
 return (...args: Parameters<T>) => {
 clearTimeout(timeout);
 timeout = setTimeout(() => fn(...args), delay);
 };
}

export function truncate(str: string, maxLen: number): string {
 if (str.length <= maxLen) return str;
 return str.slice(0, maxLen - 3) + '...';
}
