'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
 Shield,
 Eye,
 EyeOff,
 Trash2,
 Download,
 AlertTriangle,
 CheckCircle,
 Lock,
 Mic,
 Brain,
 MapPin,
 BarChart3,
 FileText,
} from 'lucide-react';
import { GlassPanel, GlassButton } from '../../../components/glass';
import { cn } from '../../../lib/utils';

interface PrivacyCategory {
 id: string;
 label: string;
 description: string;
 icon: typeof Shield;
 enabled: boolean;
 color: string;
}

export default function PrivacyScreen() {
 const [privateMode, setPrivateMode] = useState(false);
 const [categories, setCategories] = useState<PrivacyCategory[]>([
 { id: 'conversations', label: 'Conversation History', description: 'Store chat history for context', icon: FileText, enabled: true, color: '#6366f1' },
 { id: 'voice', label: 'Voice Recordings', description: 'Store voice data for improvement', icon: Mic, enabled: true, color: '#22d3ee' },
 { id: 'memory', label: 'Memory Data', description: 'Save preferences and facts', icon: Brain, enabled: true, color: '#10b981' },
 { id: 'location', label: 'Location Data', description: 'Location-aware assistance', icon: MapPin, enabled: false, color: '#f59e0b' },
 { id: 'analytics', label: 'Usage Analytics', description: 'Anonymous usage data', icon: BarChart3, enabled: true, color: '#8b5cf6' },
 ]);

 const toggleCategory = (id: string) => {
 setCategories((prev) =>
 prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c))
 );
 };

 const privacyScore = Math.round(
 (categories.filter((c) => c.enabled).length / categories.length) * 100
 );

 const getScoreLabel = () => {
 if (privacyScore >= 80) return { text: 'Excellent', color: '#10b981' };
 if (privacyScore >= 60) return { text: 'Good', color: '#22d3ee' };
 if (privacyScore >= 40) return { text: 'Moderate', color: '#f59e0b' };
 return { text: 'At Risk', color: '#ef4444' };
 };

 const scoreLabel = getScoreLabel();

 return (
 <div className="min-h-screen">
 {/* Header */}
 <div className="px-5 pt-6 pb-4">
 <h1 className="text-xl font-bold text-white">Privacy Center</h1>
 <p className="text-xs text-slate-500 mt-0.5">Control your data and privacy</p>
 </div>

 {/* Privacy Score */}
 <div className="px-5 mb-5">
 <GlassPanel padding="md" className="border-indigo-400/10">
 <div className="flex items-center gap-4">
 <div className="relative w-16 h-16 flex-shrink-0">
 <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
 <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
 <circle
 cx="18"
 cy="18"
 r="15"
 fill="none"
 stroke={scoreLabel.color}
 strokeWidth="3"
 strokeDasharray={`${privacyScore} ${100 - privacyScore}`}
 strokeLinecap="round"
 className="transition-all duration-500"
 />
 </svg>
 <div className="absolute inset-0 flex items-center justify-center">
 <Shield size={20} style={{ color: scoreLabel.color }} />
 </div>
 </div>
 <div>
 <p className="text-2xl font-bold text-white">{privacyScore}%</p>
 <div className="flex items-center gap-1.5 mt-0.5">
 <CheckCircle size={12} style={{ color: scoreLabel.color }} />
 <span className="text-xs font-medium" style={{ color: scoreLabel.color }}>
 {scoreLabel.text}
 </span>
 </div>
 <p className="text-[10px] text-slate-500 mt-0.5">Privacy Score</p>
 </div>
 </div>
 </GlassPanel>
 </div>

 {/* Private Mode */}
 <div className="px-5 mb-4">
 <GlassPanel padding="md" className={privateMode ? 'border-cyan-400/15' : ''}>
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-3">
 <div
 className="w-10 h-10 rounded-xl flex items-center justify-center"
 style={{ background: privateMode ? 'rgba(34,211,238,0.12)' : 'rgba(100,116,139,0.1)' }}
 >
 {privateMode ? <EyeOff size={20} className="text-cyan-400" /> : <Eye size={20} className="text-slate-500" />}
 </div>
 <div>
 <h3 className="text-sm font-semibold text-white">Private Mode</h3>
 <p className="text-xs text-slate-500 mt-0.5">
 {privateMode ? 'Data will not be stored' : 'No data stored during sessions'}
 </p>
 </div>
 </div>
 <button
 onClick={() => setPrivateMode(!privateMode)}
 className={`
 relative w-11 h-6 rounded-full cursor-pointer transition-colors duration-200
 ${privateMode ? 'bg-cyan-500' : 'bg-white/[0.06] border border-white/[0.08]'}
 `}
 role="switch"
 aria-checked={privateMode}
 aria-label="Private mode"
 >
 <motion.span
 animate={{ x: privateMode ? 20 : 2 }}
 transition={{ type: 'spring', stiffness: 500, damping: 30 }}
 className="block w-4 h-4 rounded-full bg-white shadow-sm"
 />
 </button>
 </div>
 {privateMode && (
 <motion.div
 initial={{ opacity: 0, height: 0 }}
 animate={{ opacity: 1, height: 'auto' }}
 className="mt-3 pt-3 border-t border-white/[0.06]"
 >
 <p className="text-xs text-cyan-400/80 flex items-center gap-1.5">
 <Lock size={12} />
 Private mode is active. Conversations won't be stored.
 </p>
 </motion.div>
 )}
 </GlassPanel>
 </div>

 {/* Data Categories */}
 <div className="px-5 mb-4">
 <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
 Data Categories
 </h2>
 <div className="space-y-2">
 {categories.map((category) => {
 const Icon = category.icon;
 return (
 <motion.div
 key={category.id}
 layout
 className="flex items-center justify-between p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]"
 >
 <div className="flex items-center gap-3">
 <div
 className="w-9 h-9 rounded-lg flex items-center justify-center"
 style={{ background: `${category.color}12` }}
 >
 <Icon size={18} style={{ color: category.color }} />
 </div>
 <div>
 <p className="text-sm font-medium text-slate-200">{category.label}</p>
 <p className="text-xs text-slate-500">{category.description}</p>
 </div>
 </div>
 <button
 onClick={() => toggleCategory(category.id)}
 className={`
 relative w-11 h-6 rounded-full cursor-pointer transition-colors duration-200
 ${category.enabled ? 'bg-indigo-500' : 'bg-white/[0.06] border border-white/[0.08]'}
 `}
 role="switch"
 aria-checked={category.enabled}
 aria-label={category.label}
 >
 <motion.span
 animate={{ x: category.enabled ? 20 : 2 }}
 transition={{ type: 'spring', stiffness: 500, damping: 30 }}
 className="block w-4 h-4 rounded-full bg-white shadow-sm"
 />
 </button>
 </motion.div>
 );
 })}
 </div>
 </div>

 {/* Actions */}
 <div className="px-5 mb-4 space-y-2">
 <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
 Data Management
 </h2>
 <GlassButton variant="secondary" size="md" className="w-full justify-center">
 <Download size={16} />
 Export My Data
 </GlassButton>
 <motion.button
 whileTap={{ scale: 0.98 }}
 className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl
 text-sm font-medium text-red-400 bg-red-500/[0.08] border border-red-500/15
 hover:bg-red-500/[0.12] transition-colors cursor-pointer"
 >
 <Trash2 size={16} />
 Delete All Data
 </motion.button>
 </div>

 {/* Danger Zone */}
 <div className="px-5 mb-8">
 <h2 className="text-xs font-semibold text-red-400/80 uppercase tracking-wider mb-3">
 Danger Zone
 </h2>
 <GlassPanel padding="md" className="border-red-500/15">
 <div className="flex items-start gap-3">
 <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
 <div className="flex-1">
 <h3 className="text-sm font-medium text-white">Delete Account</h3>
 <p className="text-xs text-slate-500 mt-1">
 Permanently remove your account and all associated data. This action cannot be undone.
 </p>
 <motion.button
 whileTap={{ scale: 0.97 }}
 className="mt-3 px-4 py-2 rounded-xl text-sm font-medium bg-red-500/15 text-red-400
 border border-red-500/20 hover:bg-red-500/25 transition-colors cursor-pointer"
 >
 Delete Account
 </motion.button>
 </div>
 </div>
 </GlassPanel>
 </div>
 </div>
 );
}
