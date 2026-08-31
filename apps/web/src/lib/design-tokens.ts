export const COLORS = {
 primary: '#6366f1',
 primaryLight: '#818cf8',
 primaryDark: '#4f46e5',
 accent: '#22d3ee',
 accentLight: '#67e8f9',
 accentDark: '#06b6d4',
 warning: '#f59e0b',
 warningLight: '#fbbf24',
 success: '#10b981',
 successLight: '#34d399',
 error: '#ef4444',
 errorLight: '#f87171',
 background: '#0b1020',
 surface: '#111827',
 surfaceLight: '#1f2937',
 surfaceLighter: '#374151',
 text: '#f8fafc',
 textSecondary: '#94a3b8',
 textDim: '#64748b',
 border: '#1e293b',
 borderLight: '#334155',
};

export const AVATAR_STATES = {
 idle: {
 label: 'Idle',
 color: COLORS.textDim,
 glow: 'rgba(100, 116, 139, 0.3)',
 animation: 'idle',
 },
 wake: {
 label: 'Listening...',
 color: COLORS.accent,
 glow: 'rgba(34, 211, 238, 0.5)',
 animation: 'pulse',
 },
 listening: {
 label: 'Listening...',
 color: COLORS.accent,
 glow: 'rgba(34, 211, 238, 0.5)',
 animation: 'pulse',
 },
 thinking: {
 label: 'Thinking...',
 color: COLORS.warning,
 glow: 'rgba(245, 158, 11, 0.5)',
 animation: 'rotate',
 },
 speaking: {
 label: 'Speaking...',
 color: COLORS.success,
 glow: 'rgba(16, 185, 129, 0.5)',
 animation: 'speak',
 },
 error: {
 label: 'Error',
 color: COLORS.error,
 glow: 'rgba(239, 68, 68, 0.5)',
 animation: 'shake',
 },
} as const;

export const ANIMATION_DURATION = {
 fast: 0.2,
 normal: 0.3,
 slow: 0.5,
 slower: 0.8,
 };
