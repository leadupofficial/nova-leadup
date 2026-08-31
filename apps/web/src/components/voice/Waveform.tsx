'use client';

import { motion } from 'framer-motion';
import { COLORS, ANIMATION_DURATION } from '../../lib/design-tokens';

interface WaveformProps {
 isActive?: boolean;
 intensity?: number;
 bars?: number;
}

export function Waveform({ isActive = false, intensity = 1, bars = 40 }: WaveformProps) {
 const barVariants = {
 idle: {
 scaleY: 0.2,
 transition: { duration: ANIMATION_DURATION.slow, ease: 'easeInOut' },
 },
 active: {
 scaleY: [0.2, 1, 0.5, 0.8, 0.2],
 transition: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' },
 },
 };

 return (
 <div className="flex items-center justify-center gap-1 h-16">
 {Array.from({ length: bars }).map((_, i) => (
 <motion.div
 key={i}
 variants={barVariants}
 animate={isActive ? 'active' : 'idle'}
 style={{
 width: '3px',
 height: '100%',
 background: isActive
 ? `linear-gradient(to top, ${COLORS.primary}, ${COLORS.accent})`
 : COLORS.textDim,
 borderRadius: '2px',
 transformOrigin: 'center',
 }}
 transition={{
 ...barVariants[isActive ? 'active' : 'idle'].transition,
 delay: i * 0.02,
 }}
 />
 ))}
 </div>
 );
}
