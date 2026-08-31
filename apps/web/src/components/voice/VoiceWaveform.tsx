'use client';

import { motion, useAnimation } from 'framer-motion';
import { useAssistantStore } from '../../stores/assistant-store';
import { COLORS, ANIMATION_DURATION } from '../../lib/design-tokens';

interface VoiceWaveformProps {
 isActive?: boolean;
 state?: 'idle' | 'listening' | 'thinking' | 'speaking';
 barCount?: number;
 className?: string;
}

export function VoiceWaveform({
 isActive = false,
 state = 'idle',
 barCount = 32,
 className = '',
}: VoiceWaveformProps) {
 const controls = useAnimation();

 useEffect(() => {
 if (!isActive) {
 controls.start({ scaleY: 0.2, transition: { duration: 0.3 } });
 return;
 }

 controls.start((i) => ({
 scaleY: state === 'thinking'
 ? Math.random() * 0.8 + 0.2
 : state === 'speaking'
 ? Math.random() * 0.9 + 0.1
 : Math.sin(i * 0.5) * 0.5 + 0.5,
 transition: {
 duration: state === 'thinking'
 ? 0.8 + Math.random() * 0.4
 : state === 'speaking'
 ? 0.2 + Math.random() * 0.2
 : 0.6 + (i % 4) * 0.1,
 repeat: Infinity,
 repeatType: 'mirror',
 ease: 'easeInOut',
 delay: i * 0.02,
 },
 }));
 }, [isActive, state, controls]);

 const getBarColor = () => {
 switch (state) {
 case 'listening': return COLORS.accent;
 case 'thinking': return COLORS.warning;
 case 'speaking': return COLORS.primary;
 default: return COLORS.primary;
 }
 };

 return (
 <div className={`flex items-center justify-center gap-[3px] h-12 ${className}`}>
 {Array.from({ length: barCount }).map((_, i) => (
 <motion.div
 key={i}
 custom={i}
 animate={controls}
 initial={{ scaleY: 0.2 }}
 className="w-[3px] rounded-full origin-bottom"
 style={{
 height: '100%',
 background: isActive
 ? `linear-gradient(to top, ${getBarColor()}, ${getBarColor()}80)`
 : `${COLORS.text}20`,
 minHeight: '4px',
 }}
 />
 ))}
 </div>
 );
}
