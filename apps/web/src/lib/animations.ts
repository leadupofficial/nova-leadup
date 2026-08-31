'use client';

import { Variants } from 'framer-motion';

export const animations: Record<string, any> = {
 fadeIn: {
 hidden: { opacity: 0 },
 visible: { opacity: 1, y: 0 },
 },
 slideUp: {
 hidden: { opacity: 0, y: 20 },
 visible: { opacity: 1, y: 0 },
 },
 slideIn: {
 hidden: { opacity: 0, x: -20 },
 visible: { opacity: 1, x: 0 },
 },
 slideInRight: {
 hidden: { opacity: 0, x: 20 },
 visible: { opacity: 1, x: 0 },
 },
 scaleIn: {
 hidden: { opacity: 0, scale: 0.9 },
 visible: { opacity: 1, scale: 1 },
 },
 staggerContainer: {
 hidden: {},
 visible: {
 staggerChildren: 0.08,
 delayChildren: 0.1,
 },
 },
 pulse: {
 scale: [1, 1.05, 1],
 transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' },
 },
 wave: (barCount: number): Variants => ({
 idle: {
 scaleY: 0.2,
 transition: { duration: 0.4, ease: 'easeInOut' },
 },
 active: {
 scaleY: [0.2, 1, 0.5, 0.8, 0.2],
 transition: {
 duration: 1.2,
 repeat: Infinity,
 ease: 'easeInOut',
 },
 },
 thinking: {
 scaleY: [0.1, 0.6, 0.3, 0.9, 0.1],
 transition: {
 duration: 0.8,
 repeat: Infinity,
 ease: 'easeInOut',
 },
 },
 speaking: {
 scaleY: [0.3, 1, 0.4, 0.9, 0.3],
 transition: {
 duration: 0.5,
 repeat: Infinity,
 ease: 'easeInOut',
 },
 },
 }),
 shimmer: {
 hidden: { opacity: 0.5 },
 visible: {
 opacity: 1,
 transition: {
 opacity: { repeat: Infinity, repeatType: 'reverse', duration: 1.2 },
 },
 },
 },
 float: {
 y: [0, -8, 0],
 transition: {
 duration: 3,
 repeat: Infinity,
 ease: 'easeInOut',
 },
 },
 glow: {
 boxShadow: [
 '0 0 20px rgba(99,102,241,0.3)',
 '0 0 40px rgba(99,102,241,0.6)',
 '0 0 20px rgba(99,102,241,0.3)',
 ],
 transition: {
 duration: 2,
 repeat: Infinity,
 ease: 'easeInOut',
 },
 },
 pageTransition: {
 initial: { opacity: 0, y: 10 },
 animate: { opacity: 1, y: 0 },
 exit: { opacity: 0, y: -10 },
 transition: { duration: 0.3, ease: 'easeOut' },
 },
 listItem: {
 hidden: { opacity: 0, y: 12 },
 visible: (i: number) => ({
 opacity: 1,
 y: 0,
 transition: { delay: i * 0.05, duration: 0.3 },
 }),
 },
 typingDot: {
 hidden: { opacity: 0.3 },
 visible: (i: number) => ({
 opacity: [0.3, 1, 0.3],
 transition: {
 duration: 1,
 repeat: Infinity,
 delay: i * 0.2,
 },
 }),
 },
} as const;

export type AnimationKey = keyof typeof animations;
