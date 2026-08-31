'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Sparkles, Mic, Brain, Shield } from 'lucide-react';
import { COLORS, ANIMATION_DURATION } from '../../lib/design-tokens';
import { Avatar } from '../../components/avatar/Avatar';

type OnboardingStep = 'welcome' | 'features' | 'voice' | 'privacy' | 'complete';

const features = [
 {
 icon: Mic,
 title: 'Voice-First',
 description: 'Talk naturally with your AI assistant. Just say "Hey NOVA" to start.',
 color: COLORS.accent,
 },
 {
 icon: Brain,
 title: 'Intelligent Memory',
 description: 'NOVA remembers your preferences, conversations, and important details.',
 color: COLORS.primary,
 },
 {
 icon: Sparkles,
 title: 'Proactive Help',
 description: 'Get reminders, suggestions, and assistance before you even ask.',
 color: COLORS.warning,
 },
 {
 icon: Shield,
 title: 'Privacy First',
 description: 'Your data stays yours. Full control over what NOVA remembers.',
 color: COLORS.success,
 },
];

export default function Onboarding() {
 const [step, setStep] = useState<OnboardingStep>('welcome');
 const [userName, setUserName] = useState('');
 const [selectedVoice, setSelectedVoice] = useState('nova');
 const [privacyLevel, setPrivacyLevel] = useState<'full' | 'balanced' | 'private'>('balanced');

 const nextStep = () => {
 const steps: OnboardingStep[] = ['welcome', 'features', 'voice', 'privacy', 'complete'];
 const currentIndex = steps.indexOf(step);
 if (currentIndex < steps.length - 1) {
 setStep(steps[currentIndex + 1]);
 }
 };

 return (
 <div className="min-h-screen bg-nova-bg flex items-center justify-center p-4">
 <AnimatePresence mode="wait">
 <motion.div
 key={step}
 initial={{ opacity: 0, x: 20 }}
 animate={{ opacity: 1, x: 0 }}
 exit={{ opacity: 0, x: -20 }}
 transition={{ duration: ANIMATION_DURATION.normal }}
 className="w-full max-w-md"
 >
 {step === 'welcome' && (
 <div className="text-center space-y-8">
 <motion.div
 initial={{ scale: 0 }}
 animate={{ scale: 1 }}
 transition={{ type: 'spring', duration: 0.8 }}
 className="flex justify-center"
 >
 <Avatar state="idle" size={140} emotion="neutral" />
 </motion.div>

 <div className="space-y-3">
 <motion.h1
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: 0.2 }}
 className="text-4xl font-bold bg-gradient-to-r from-nova-primary to-nova-accent bg-clip-text text-transparent"
 >
 NOVA
 </motion.h1>
 <motion.p
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 transition={{ delay: 0.4 }}
 className="text-nova-text-secondary text-lg"
 >
 Your personal AI companion
 </motion.p>
 </div>

 <motion.div
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 transition={{ delay: 0.6 }}
 className="space-y-4"
 >
 <input
 type="text"
 value={userName}
 onChange={(e) => setUserName(e.target.value)}
 placeholder="What's your name?"
 className="w-full px-4 py-3 bg-nova-surface border border-nova-border rounded-xl text-nova-text placeholder-nova-text-dim focus:outline-none focus:border-nova-primary transition-colors"
 />
 <button
 onClick={nextStep}
 disabled={!userName.trim()}
 className="w-full py-3 bg-gradient-to-r from-nova-primary to-nova-accent rounded-xl font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
 >
 Get Started
 <ChevronRight size={20} />
 </button>
 </motion.div>
 </div>
 )}

 {step === 'features' && (
 <div className="space-y-6">
 <h2 className="text-3xl font-bold text-nova-text text-center mb-8">
 What NOVA can do
 </h2>
 <div className="space-y-4">
 {features.map((feature, index) => {
 const Icon = feature.icon;
 return (
 <motion.div
 key={feature.title}
 initial={{ opacity: 0, y: 20 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: index * 0.1 }}
 className="p-4 bg-nova-surface border border-nova-border rounded-xl"
 >
 <div className="flex items-start gap-4">
 <div
 className="p-3 rounded-lg"
 style={{ background: `${feature.color}20` }}
 >
 <Icon size={24} style={{ color: feature.color }} />
 </div>
 <div className="flex-1">
 <h3 className="font-semibold text-nova-text mb-1">{feature.title}</h3>
 <p className="text-sm text-nova-text-secondary">{feature.description}</p>
 </div>
 </div>
 </motion.div>
 );
 })}
 </div>
 <button
 onClick={nextStep}
 className="w-full py-3 bg-gradient-to-r from-nova-primary to-nova-accent rounded-xl font-semibold text-white flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
 >
 Continue
 <ChevronRight size={20} />
 </button>
 </div>
 )}

 {step === 'voice' && (
 <div className="space-y-6">
 <h2 className="text-3xl font-bold text-nova-text text-center mb-8">
 Choose your voice
 </h2>
 <div className="space-y-3">
 {['Nova', 'Aria', 'Echo', 'Luna'].map((voice) => (
 <motion.button
 key={voice}
 whileTap={{ scale: 0.98 }}
 onClick={() => setSelectedVoice(voice.toLowerCase())}
 className={`w-full p-4 rounded-xl border-2 transition-all ${
 selectedVoice === voice.toLowerCase()
 ? 'border-nova-primary bg-nova-primary/10'
 : 'border-nova-border bg-nova-surface hover:border-nova-border-light'
 }`}
 >
 <div className="flex items-center justify-between">
 <div>
 <h3 className="font-semibold text-nova-text">{voice}</h3>
 <p className="text-sm text-nova-text-secondary">
 {voice === 'Nova' && 'Clear and professional'}
 {voice === 'Aria' && 'Warm and friendly'}
 {voice === 'Echo' && 'Calm and soothing'}
 {voice === 'Luna' && 'Energetic and upbeat'}
 </p>
 </div>
 {selectedVoice === voice.toLowerCase() && (
 <div className="w-6 h-6 rounded-full bg-nova-primary flex items-center justify-center">
 <div className="w-2 h-2 rounded-full bg-white" />
 </div>
 )}
 </div>
 </motion.button>
 ))}
 </div>
 <button
 onClick={nextStep}
 className="w-full py-3 bg-gradient-to-r from-nova-primary to-nova-accent rounded-xl font-semibold text-white flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
 >
 Continue
 <ChevronRight size={20} />
 </button>
 </div>
 )}

 {step === 'privacy' && (
 <div className="space-y-6">
 <h2 className="text-3xl font-bold text-nova-text text-center mb-8">
 Privacy settings
 </h2>
 <div className="space-y-3">
 {[
 {
 id: 'full',
 label: 'Full Memory',
 desc: 'NOVA remembers everything to provide the best experience',
 },
 {
 id: 'balanced',
 label: 'Balanced',
 desc: 'Remember important info, clear old conversations',
 },
 {
 id: 'private',
 label: 'Private Mode',
 desc: 'No long-term memory, everything cleared after session',
 },
 ].map((option) => (
 <motion.button
 key={option.id}
 whileTap={{ scale: 0.98 }}
 onClick={() => setPrivacyLevel(option.id as typeof privacyLevel)}
 className={`w-full p-4 rounded-xl border-2 transition-all text-left ${
 privacyLevel === option.id
 ? 'border-nova-primary bg-nova-primary/10'
 : 'border-nova-border bg-nova-surface hover:border-nova-border-light'
 }`}
 >
 <h3 className="font-semibold text-nova-text mb-1">{option.label}</h3>
 <p className="text-sm text-nova-text-secondary">{option.desc}</p>
 </motion.button>
 ))}
 </div>
 <button
 onClick={nextStep}
 className="w-full py-3 bg-gradient-to-r from-nova-primary to-nova-accent rounded-xl font-semibold text-white flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
 >
 Complete Setup
 <ChevronRight size={20} />
 </button>
 </div>
 )}

 {step === 'complete' && (
 <div className="text-center space-y-8">
 <motion.div
 initial={{ scale: 0 }}
 animate={{ scale: 1 }}
 transition={{ type: 'spring', duration: 0.8 }}
 className="flex justify-center"
 >
 <Avatar state="wake" size={140} emotion="happy" />
 </motion.div>
 <div className="space-y-3">
 <motion.h1
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: 0.2 }}
 className="text-4xl font-bold text-nova-text"
 >
 Welcome, {userName}!
 </motion.h1>
 <motion.p
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 transition={{ delay: 0.4 }}
 className="text-nova-text-secondary text-lg"
 >
 NOVA is ready to help. Say "Hey NOVA" or tap the mic to start.
 </motion.p>
 </div>
 <motion.button
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 transition={{ delay: 0.6 }}
 onClick={() => (window.location.href = '/dashboard')}
 className="w-full py-3 bg-gradient-to-r from-nova-primary to-nova-accent rounded-xl font-semibold text-white hover:opacity-90 transition-opacity"
 >
 Enter NOVA
 </motion.button>
 </div>
 )}
 </motion.div>
 </AnimatePresence>
 </div>
 );
}
