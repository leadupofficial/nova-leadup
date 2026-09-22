export const colors = {
 nova: {
 bg: '#0b1020',
 surface: '#0f172a',
 'surface-alt': '#1e293b',
 primary: '#6366f1',
 'primary-light': '#818cf8',
 'primary-dark': '#4f46e5',
 accent: '#22d3ee',
 'accent-light': '#67e8f9',
 'accent-dark': '#06b6d4',
 warning: '#f59e0b',
 success: '#10b981',
 error: '#ef4444',
 text: '#f8fafc',
 'text-secondary': '#94a3b8',
 'text-dim': '#64748b',
 border: '#1e293b',
 'border-light': '#334155',
 },
} as const;

export type ColorKey = keyof typeof colors.nova;
