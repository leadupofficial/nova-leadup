'use client';

import { motion, useAnimation, useEffect } from 'framer-motion';
import { AVATAR_STATES, COLORS, ANIMATION_DURATION } from '../../lib/design-tokens';

interface AvatarProps {
 state?: keyof typeof AVATAR_STATES;
 size?: number;
 emotion?: 'happy' | 'calm' | 'excited' | 'concerned' | 'neutral';
}

export function Avatar({ state = 'idle', size = 120, emotion = 'neutral' }: AvatarProps) {
 const controls = useAnimation();
 const config = AVATAR_STATES[state];

 useEffect(() => {
 controls.start(getAnimationVariant(state));
 }, [state, controls]);

 const getAnimationVariant = (currentState: keyof typeof AVATAR_STATES) => {
 switch (currentState) {
 case 'listening':
 return {
 scale: [1, 1.05, 1],
 transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' },
 };
 case 'thinking':
 return {
 rotate: [0, 360],
 transition: { duration: 8, repeat: Infinity, ease: 'linear' },
 };
 case 'speaking':
 return {
 scale: [1, 1.08, 1],
 transition: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' },
 };
 case 'wake':
 return {
 scale: [1, 1.1, 1],
 boxShadow: [
 `0 0 20px ${config.glow}`,
 `0 0 60px ${config.glow}`,
 `0 0 20px ${config.glow}`,
 ],
 transition: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' },
 };
 default:
 return {};
 }
 };

 const getEmotionFace = () => {
 switch (emotion) {
 case 'happy':
 return '😊';
 case 'excited':
 return '🤩';
 case 'calm':
 return '😌';
 case 'concerned':
 return '😟';
 default:
 return '✨';
 }
 };

 return (
 <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
 {/* Outer glow ring */}
 <motion.div
 className="absolute inset-0 rounded-full"
 style={{
 background: `radial-gradient(circle, ${config.glow} 0%, transparent 70%)`,
 }}
 animate={controls}
 />

 {/* Rotating outer ring */}
 <svg
 className="absolute inset-0"
 width={size}
 height={size}
 viewBox="0 0 120 120"
 >
 <motion.circle
 cx="60"
 cy="60"
 r="56"
 fill="none"
 stroke={config.color}
 strokeWidth="1.5"
 strokeDasharray="8 4"
 animate={{
 rotate: state === 'thinking' ? 360 : 0,
 opacity: state === 'idle' ? 0.3 : 0.8,
 }}
 transition={{
 rotate: { duration: 8, repeat: Infinity, ease: 'linear' },
 opacity: { duration: ANIMATION_DURATION.normal },
 }}
 style={{ transformOrigin: 'center' }}
 />
 </svg>

 {/* Main avatar circle */}
 <motion.div
 className="rounded-full flex items-center justify-center"
 style={{
 width: size * 0.75,
 height: size * 0.75,
 background: `linear-gradient(135deg, ${COLORS.primary} 0%, ${COLORS.accent} 100%)`,
 boxShadow: `0 0 ${size * 0.2}px ${config.glow}`,
 }}
 animate={controls}
 >
 <div className="text-4xl">{getEmotionFace()}</div>
 </motion.div>

 {/* Status indicator */}
 {state !== 'idle' && (
 <motion.div
 className="absolute bottom-0 right-0 w-4 h-4 rounded-full border-2"
 style={{
 background: config.color,
 borderColor: COLORS.background,
 }}
 animate={{
 scale: [1, 1.2, 1],
 }}
 transition={{
 duration: 1,
 repeat: Infinity,
 ease: 'easeInOut',
 }}
 />
 )}
 </div>
 );
}
