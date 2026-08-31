'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
 ChevronRight,
 Mic,
 Globe,
 Palette,
 Bell,
 Shield,
 Volume2,
 Zap,
 Trash2,
 Download,
 User,
 Brain,
} from 'lucide-react';
import { GlassPanel, GlassButton } from '../../../components/glass';
import { Badge } from '../../../components/ui/Badge';
import { useAssistantStore } from '../../../stores/assistant-store';
import { useMemoryStore } from '../../../stores/memory-store';

interface ToggleProps {
 label: string;
 description?: string;
 enabled: boolean;
 onToggle: () => void;
}

function Toggle({ label, description, enabled, onToggle }: ToggleProps) {
 return (
 <div className="flex items-center justify-between py-2.5">
 <div className="flex-1 min-w-0 mr-4">
 <p className="text-sm font-medium text-slate-200">{label}</p>
 {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
 </div>
 <button
 onClick={onToggle}
 className={`
 relative w-11 h-6 rounded-full cursor-pointer transition-colors duration-200
 ${enabled ? 'bg-indigo-500' : 'bg-white/[0.06] border border-white/[0.08]'}
 `}
 role="switch"
 aria-checked={enabled}
 aria-label={label}
 >
 <motion.span
 animate={{ x: enabled ? 20 : 2 }}
 transition={{ type: 'spring', stiffness: 500, damping: 30 }}
 className="block w-4 h-4 rounded-full bg-white shadow-sm"
 />
 </button>
 </div>
 );
}

const VOICE_OPTIONS = ['Sarvam Female (Tamil)', 'Sarvam Male (Tamil)', 'ElevenLabs (English)', 'Auto'];

const PERSONALITY_OPTIONS = [
 { value: 'friendly', label: 'Friendly', desc: 'Warm and conversational' },
 { value: 'professional', label: 'Professional', desc: 'Formal and precise' },
 { value: 'executive', label: 'Executive', desc: 'Concise and directive' },
 { value: 'companion', label: 'Companion', desc: 'Supportive and personal' },
];

export default function SettingsScreen() {
 const { state } = useAssistantStore();
 const { preferences, updatePreferences } = useMemoryStore();
 const [companionName, setCompanionName] = useState('NOVA');
 const [personality, setPersonality] = useState('friendly');
 const [voice, setVoice] = useState(VOICE_OPTIONS[0]);
 const [language, setLanguage] = useState('Auto (Tamil + English)');
 const [notificationsEnabled, setNotificationsEnabled] = useState(true);
 const [voiceOutputEnabled, setVoiceOutputEnabled] = useState(true);
 const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
 const [memoryEnabled, setMemoryEnabled] = useState(true);
 const [proactiveEnabled, setProactiveEnabled] = useState(true);

 const isListening = state === 'listening';

 return (
 <div className="min-h-screen">
 {/* Profile */}
 <div className="px-5 pt-6 pb-4">
 <div className="flex items-center gap-4">
 <div className="relative">
 <div
 className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-white
 bg-gradient-to-br from-indigo-500 to-cyan-400 shadow-lg shadow-indigo-500/20"
 >
 {companionName.charAt(0)}
 </div>
 {isListening && (
 <span className="absolute bottom-0 right-0 w-4 h-4 rounded-full bg-cyan-400 border-2 border-[#0b1020]" />
 )}
 </div>
 <div className="flex-1">
 <h1 className="text-lg font-bold text-white">{companionName}</h1>
 <p className="text-sm text-slate-500">@abishek</p>
 <Badge variant="primary" size="sm" dot>
 Pro Plan
 </Badge>
 </div>
 <motion.button
 whileTap={{ scale: 0.92 }}
 className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]"
 aria-label="Edit profile"
 >
 <User size={18} className="text-slate-400" />
 </motion.button>
 </div>
 </div>

 {/* Sections */}
 <div className="px-5 space-y-4 pb-6">
 {/* Identity */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <User size={16} className="text-indigo-400" />
 <h2 className="text-sm font-semibold text-white">Identity</h2>
 </div>
 <div className="space-y-3">
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">Companion Name</label>
 <input
 type="text"
 value={companionName}
 onChange={(e) => setCompanionName(e.target.value)}
 className="w-full px-3 py-2 rounded-xl text-sm text-white bg-white/[0.04] border border-white/[0.08]
 focus:outline-none focus:border-indigo-400/40 transition-colors"
 />
 </div>
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">Personality</label>
 <div className="grid grid-cols-2 gap-2">
 {PERSONALITY_OPTIONS.map((opt) => (
 <button
 key={opt.value}
 onClick={() => setPersonality(opt.value)}
 className={`
 px-3 py-2 rounded-xl text-left text-xs transition-all duration-200 border cursor-pointer
 ${
 personality === opt.value
 ? 'bg-indigo-500/15 border-indigo-400/25 text-indigo-300'
 : 'bg-white/[0.03] border-transparent text-slate-400 hover:text-slate-300'
 }
 `}
 >
 <p className="font-medium">{opt.label}</p>
 <p className="text-[10px] opacity-70">{opt.desc}</p>
 </button>
 ))}
 </div>
 </div>
 </div>
 </GlassPanel>

 {/* Voice & Language */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <Volume2 size={16} className="text-cyan-400" />
 <h2 className="text-sm font-semibold text-white">Voice & Language</h2>
 </div>
 <div className="space-y-3">
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">Voice</label>
 <select
 value={voice}
 onChange={(e) => setVoice(e.target.value)}
 className="w-full px-3 py-2 rounded-xl text-sm text-white bg-white/[0.04] border border-white/[0.08]
 focus:outline-none focus:border-indigo-400/40 transition-colors"
 >
 {VOICE_OPTIONS.map((v) => (
 <option key={v} value={v}>{v}</option>
 ))}
 </select>
 </div>
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">Language</label>
 <select
 value={language}
 onChange={(e) => setLanguage(e.target.value)}
 className="w-full px-3 py-2 rounded-xl text-sm text-white bg-white/[0.04] border border-white/[0.08]
 focus:outline-none focus:border-indigo-400/40 transition-colors"
 >
 <option>Auto (Tamil + English)</option>
 <option>English only</option>
 <option>Tamil only</option>
 <option>Tamil + English</option>
 </select>
 </div>
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">
 Speech Speed: {preferences.voice.speed.toFixed(1)}x
 </label>
 <input
 type="range"
 min="0.5"
 max="2"
 step="0.1"
 value={preferences.voice.speed}
 onChange={(e) => updatePreferences({voice: {...preferences.voice, speed: parseFloat(e.target.value)}})}
 className="w-full accent-indigo-500"
 />
 </div>
 </div>
 </GlassPanel>

 {/* Features */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <Zap size={16} className="text-amber-400" />
 <h2 className="text-sm font-semibold text-white">Features</h2>
 </div>
 <Toggle
 label="Voice Output"
 description="Speak responses aloud"
 enabled={voiceOutputEnabled}
 onToggle={() => setVoiceOutputEnabled(!voiceOutputEnabled)}
 />
 <Toggle
 label="Notifications"
 description="Push alerts for reminders"
 enabled={notificationsEnabled}
 onToggle={() => setNotificationsEnabled(!notificationsEnabled)}
 />
 <Toggle
 label="Wake Word"
 description="Say 'Hey NOVA' to activate"
 enabled={wakeWordEnabled}
 onToggle={() => setWakeWordEnabled(!wakeWordEnabled)}
 />
 <Toggle
 label="Proactive Assistance"
 description="Get suggestions before you ask"
 enabled={proactiveEnabled}
 onToggle={() => setProactiveEnabled(!proactiveEnabled)}
 />
 <Toggle
 label="Memory"
 description="Save facts for future conversations"
 enabled={memoryEnabled}
 onToggle={() => setMemoryEnabled(!memoryEnabled)}
 />
 </GlassPanel>

 {/* Memory */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <Brain size={16} className="text-emerald-400" />
 <h2 className="text-sm font-semibold text-white">Memory</h2>
 </div>
 <div>
 <label className="text-xs text-slate-500 block mb-1.5">Response Length</label>
 <div className="grid grid-cols-3 gap-2">
 {(['short', 'medium', 'long'] as const).map((length) => (
 <button
 key={length}
 onClick={() => updatePreferences({ai: {...preferences.ai, responseLength: length}})}
 className={`
 py-2 rounded-xl text-xs font-medium transition-all border cursor-pointer
 ${
 preferences.ai.responseLength === length
 ? 'bg-emerald-500/15 border-emerald-400/25 text-emerald-300'
 : 'bg-white/[0.03] border-transparent text-slate-400'
 }
 `}
 >
 {length === 'short' ? 'Brief' : length === 'medium' ? 'Standard' : 'Detailed'}
 </button>
 ))}
 </div>
 </div>
 <div className="mt-3 pt-3 border-t border-white/[0.06]">
 <button className="flex items-center gap-2 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer">
 <Trash2 size={14} />
 Clear all memory
 </button>
 </div>
 </GlassPanel>

 {/* Privacy */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <Shield size={16} className="text-violet-400" />
 <h2 className="text-sm font-semibold text-white">Privacy</h2>
 </div>
 <div className="space-y-3">
 <Link href="/dashboard/privacy" className="block">
 <div className="flex items-center justify-between py-1">
 <div>
 <p className="text-sm text-slate-300">Privacy Center</p>
 <p className="text-xs text-slate-500">Manage data & permissions</p>
 </div>
 <ChevronRight size={16} className="text-slate-600" />
 </div>
 </Link>
 <Toggle
 label="Private Mode"
 description="Don't store conversation data"
 enabled={false}
 onToggle={() => {}}
 />
 </div>
 </GlassPanel>

 {/* Data */}
 <GlassPanel padding="md">
 <div className="flex items-center gap-2 mb-3">
 <Download size={16} className="text-indigo-400" />
 <h2 className="text-sm font-semibold text-white">Data</h2>
 </div>
 <div className="space-y-2">
 <GlassButton variant="secondary" size="sm" className="w-full justify-center">
 <Download size={14} />
 Export My Data
 </GlassButton>
 </div>
 </GlassPanel>

 {/* Version */}
 <p className="text-center text-xs text-slate-600 pt-4">
 NOVA v0.1.0 · Built with care
 </p>
 </div>
 </div>
 );
}
