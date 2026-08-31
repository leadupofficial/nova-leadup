'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface VoiceWaveformProps {
 state?: VoiceState;
 barCount?: number;
 className?: string;
 height?: number;
}

const STATE_CONFIG: Record<VoiceState, { variant: string; gradient: string; minScale: number }> = {
 idle: {
 variant: 'idle',
 gradient: 'rgb(148, 163, 184)',
 minScale: 0.15,
 },
 listening: {
 variant: 'active',
 gradient: 'rgb(34, 211, 238)',
 minScale: 0.3,
 },
 thinking: {
 variant: 'thinking',
 gradient: 'rgb(245, 158, 11)',
 minScale: 0.1,
 },
 speaking: {
 variant: 'speaking',
 gradient: 'rgb(16, 185, 129)',
 minScale: 0.2,
 },
 error: {
 variant: 'error',
 gradient: 'rgb(239, 68, 68)',
 minScale: 0.1,
 },
};

function getBarDelay(index: number, total: number, state: VoiceState): number {
 const center = total / 2;
 const distance = Math.abs(index - center) / center;
 const baseDelay = distance * 0.3;

 switch (state) {
 case 'listening':
 return baseDelay + index * 0.015;
 case 'thinking':
 return baseDelay + index * 0.025;
 case 'speaking':
 return baseDelay + index * 0.01;
 case 'error':
 return baseDelay + index * 0.02;
 default:
 return 0;
 }
}

export function VoiceWaveform({
 state = 'idle',
 barCount = 28,
 className = '',
 height = 48,
}: VoiceWaveformProps) {
 const config = STATE_CONFIG[state];
 const bars = useMemo(() => Array.from({ length: barCount }), [barCount]);

 const getBarVariant = (index: number) => {
 const delay = getBarDelay(index, barCount, state);

 switch (state) {
 case 'listening':
 return {
 animate: { scaleY: [0.3, 1, 0.5, 0.9, 0.3] },
 transition: {
 duration: 1.2 + Math.random() * 0.4,
 repeat: Infinity,
 ease: 'easeInOut',
 delay,
 },
 };
 case 'thinking':
 return {
 animate: { scaleY: [0.1, 0.7, 0.2, 0.9, 0.1] },
 transition: {
 duration: 0.7 + Math.random() * 0.3,
 repeat: Infinity,
 ease: 'easeInOut',
 delay,
 },
 };
 case 'speaking':
 return {
 animate: { scaleY: [0.2, 1, 0.3, 0.8, 0.2] },
 transition: {
 duration: 0.4 + Math.random() * 0.3,
 repeat: Infinity,
 ease: 'easeInOut',
 delay,
 },
 };
 case 'error':
 return {
 animate: { scaleY: [0.1, 0.4, 0.1, 0.6, 0.1] },
 transition: {
 duration: 0.5,
 repeat: Infinity,
 ease: 'easeInOut',
 delay: getBarDelay(index, barCount, state),
 },
 };
 default:
 return {
 animate: { scaleY: 0.15 },
 transition: { duration: 0.4 },
 };
 }
 };

 return (
 <div
 className={cn('flex items-center justify-center gap-[2px]', className)}
 style={{ height }}
 role="img"
 aria-label={state === 'idle' ? 'Voice idle' : `Voice ${state}`}
 >
 {bars.map((_, i) => (
 <motion.div
 key={i}
 initial={{ scaleY: config.minScale }}
 {...getBarVariant(i)}
 style={{
 width: 3,
 height: '100%',
 borderRadius: 2,
 transformOrigin: 'center',
 background: config.gradient,
 opacity: state === 'idle' ? 0.3 : 0.8,
 }}
 />
 ))}
 </div>
 );
}
