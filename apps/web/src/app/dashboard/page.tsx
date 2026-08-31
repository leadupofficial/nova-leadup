'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
 Bell,
 Settings,
 Mic,
 MicOff,
 Calendar,
 Brain,
 BellRing,
 MessageSquare,
 ChevronRight,
 Sparkles,
 Clock,
 CheckCircle,
 AlertTriangle,
 TrendingUp,
} from 'lucide-react';
import { Avatar } from '../../components/avatar/Avatar';
import { VoiceWaveform } from '../../components/glass/VoiceWaveform';
import { GlassPanel, GlassButton } from '../../components/glass';
import { useAssistantStore } from '../../stores/assistant-store';
import { useTaskStore } from '../../stores/task-store';
import { useMemoryStore } from '../../stores/memory-store';
import { useConversationStore } from '../../stores/conversation-store';
import { formatTime, formatRelativeTime } from '../../lib/utils';
import { animations } from '../../lib/animations';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const QUICK_STATS = [
 {
 label: 'Tasks Today',
 value: '3',
 icon: Calendar,
 color: '#6366f1',
 bg: 'rgba(99,102,241,0.12)',
 },
 {
 label: 'Memories',
 value: '12',
 icon: Brain,
 color: '#22d3ee',
 bg: 'rgba(34,211,238,0.12)',
 },
 {
 label: 'Reminders',
 value: '3',
 icon: BellRing,
 color: '#f59e0b',
 bg: 'rgba(245,158,11,0.12)',
 },
 {
 label: 'Chats',
 value: '8',
 icon: MessageSquare,
 color: '#10b981',
 bg: 'rgba(16,185,129,0.12)',
 },
];

const RECENT_ITEMS = [
 {
 id: '1',
 title: 'Call Kumar about CRM proposal',
 time: 'Tomorrow, 10:00 AM',
 type: 'task',
 status: 'pending',
 },
 {
 id: '2',
 title: 'Weekly BNI meeting prep',
 time: 'Today, 2:00 PM',
 type: 'reminder',
 status: 'pending',
 },
 {
 id: '3',
 title: 'Tamil-English (Tanglish) preference',
 time: 'Aug 20',
 type: 'memory',
 status: 'info',
 },
];

const SUGGESTED_ACTIONS = [
 {
 icon: Sparkles,
 label: 'Plan my day',
 desc: 'Review today\'s schedule and priorities',
 color: '#6366f1',
 },
 {
 icon: MessageSquare,
 label: 'Quick note',
 desc: 'Save a thought or reminder',
 color: '#22d3ee',
 },
 {
 icon: Calendar,
 label: 'Check calendar',
 desc: 'See upcoming meetings',
 color: '#f59e0b',
 },
];

export default function Dashboard() {
 const { state, setState } = useAssistantStore();
 const tasks = useTaskStore((s) => s.tasks);
 const memories = useMemoryStore((s) => s.memories);
 const messages = useConversationStore((s) => s.messages);

 const pendingTasks = useMemo(() => tasks.filter((t) => !t.completed).length, [tasks]);

 const getGreeting = () => {
 const hour = new Date().getHours();
 if (hour < 12) return 'Good morning';
 if (hour < 17) return 'Good afternoon';
 return 'Good evening';
 };

 const getDateLabel = () => {
 return new Date().toLocaleDateString('en-US', {
 weekday: 'long',
 month: 'short',
 day: 'numeric',
 });
 };

 const handleVoiceToggle = () => {
 if (state === 'listening') {
 setState('idle');
 } else {
 setState('listening');
 }
 };

 const containerVariants = animations.staggerContainer;
 const itemVariants = animations.listItem;

 return (
 <div className="min-h-screen pb-24">
 {/* Header */}
 <motion.header
 initial={{ opacity: 0, y: -10 }}
 animate={{ opacity: 1, y: 0 }}
 className="px-5 pt-6 pb-4"
 >
 <div className="flex items-start justify-between">
 <div>
 <h1 className="text-2xl font-bold text-white tracking-tight">
 {getGreeting()}
 </h1>
 <p className="text-sm text-slate-400 mt-0.5 flex items-center gap-1.5">
 <Clock size={14} />
 {getDateLabel()}
 </p>
 </div>
 <div className="flex items-center gap-2">
 <motion.button
 whileTap={{ scale: 0.92 }}
 className="relative p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]
 hover:bg-white/[0.08] transition-colors"
 aria-label="Notifications"
 >
 <Bell size={20} className="text-slate-400" />
 <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-400 rounded-full" />
 </motion.button>
 <Link href="/dashboard/settings">
 <motion.button
 whileTap={{ scale: 0.92 }}
 className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]
 hover:bg-white/[0.08] transition-colors"
 aria-label="Settings"
 >
 <Settings size={20} className="text-slate-400" />
 </motion.button>
 </Link>
 </div>
 </div>
 </motion.header>

 {/* Avatar Section */}
 <motion.div
 initial={{ opacity: 0, scale: 0.9 }}
 animate={{ opacity: 1, scale: 1 }}
 transition={{ duration: 0.5, ease: 'easeOut' }}
 className="flex flex-col items-center pt-4 pb-6"
 >
 <div className="relative">
 <Avatar state={state} size={140} />
 </div>
 <div className="mt-4 text-center">
 <p className="text-base font-medium text-slate-200">
 {state === 'idle' && "I'm ready to help"}
 {state === 'listening' && 'Listening...'}
 {state === 'thinking' && 'Thinking...'}
 {state === 'speaking' && 'Speaking...'}
 </p>
 <div className="mt-2">
 <VoiceWaveform state={state} height={36} barCount={24} />
 </div>
 </div>

 {/* Voice CTA */}
 <motion.button
 whileTap={{ scale: 0.95 }}
 onClick={handleVoiceToggle}
 className={`
 mt-5 px-8 py-3.5 rounded-2xl font-semibold text-base
 flex items-center gap-3 transition-all duration-200
 ${
 state === 'listening'
 ? 'bg-cyan-500/15 border-2 border-cyan-400/40 text-cyan-300'
 : 'bg-gradient-to-r from-indigo-500 to-cyan-400 text-white shadow-lg shadow-indigo-500/25'
 }
 `}
 >
 {state === 'listening' ? (
 <>
 <MicOff size={22} />
 Stop Listening
 </>
 ) : (
 <>
 <Mic size={22} />
 Tap to Talk
 </>
 )}
 </motion.button>
 </motion.div>

 {/* Quick Stats */}
 <motion.div
 variants={containerVariants}
 initial="hidden"
 animate="visible"
 className="px-5 mb-6"
 >
 <div className="grid grid-cols-4 gap-3">
 {QUICK_STATS.map((stat) => {
 const Icon = stat.icon;
 return (
 <motion.div key={stat.label} variants={itemVariants} custom={stat.label}>
 <GlassPanel padding="sm" hoverable className="text-center">
 <div
 className="w-9 h-9 rounded-lg flex items-center justify-center mx-auto mb-2"
 style={{ background: stat.bg }}
 >
 <Icon size={18} style={{ color: stat.color }} />
 </div>
 <p className="text-lg font-bold text-white leading-none">{stat.value}</p>
 <p className="text-[10px] text-slate-400 mt-1 leading-tight">{stat.label}</p>
 </GlassPanel>
 </motion.div>
 );
 })}
 </div>
 </motion.div>

 {/* Suggested Actions */}
 <motion.div
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: 0.2 }}
 className="px-5 mb-6"
 >
 <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
 Suggested
 </h2>
 <div className="space-y-2">
 {SUGGESTED_ACTIONS.map((action) => {
 const Icon = action.icon;
 return (
 <motion.div
 key={action.label}
 whileTap={{ scale: 0.98 }}
 className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]
 hover:border-white/[0.12] hover:bg-white/[0.06] transition-all cursor-pointer"
 >
 <div
 className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
 style={{ background: `${action.color}18` }}
 >
 <Icon size={18} style={{ color: action.color }} />
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-sm font-medium text-white truncate">{action.label}</p>
 <p className="text-xs text-slate-500 truncate">{action.desc}</p>
 </div>
 <ChevronRight size={16} className="text-slate-600 flex-shrink-0" />
 </motion.div>
 );
 })}
 </div>
 </motion.div>

 {/* Recent Activity */}
 <motion.div
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: 0.3 }}
 className="px-5 mb-6"
 >
 <div className="flex items-center justify-between mb-3">
 <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
 Recent Activity
 </h2>
 <Link href="/dashboard/converse">
 <span className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
 View all
 </span>
 </Link>
 </div>
 <div className="space-y-2">
 {RECENT_ITEMS.map((item) => (
 <GlassPanel key={item.id} padding="sm" hoverable>
 <div className="flex items-center gap-3">
 <div className="flex-shrink-0">
 {item.type === 'task' && (
 <div className="w-8 h-8 rounded-lg bg-indigo-500/12 flex items-center justify-center">
 <Calendar size={16} className="text-indigo-400" />
 </div>
 )}
 {item.type === 'reminder' && (
 <div className="w-8 h-8 rounded-lg bg-amber-500/12 flex items-center justify-center">
 <BellRing size={16} className="text-amber-400" />
 </div>
 )}
 {item.type === 'memory' && (
 <div className="w-8 h-8 rounded-lg bg-cyan-500/12 flex items-center justify-center">
 <Brain size={16} className="text-cyan-400" />
 </div>
 )}
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-sm text-slate-200 truncate">{item.title}</p>
 <p className="text-xs text-slate-500 mt-0.5">{item.time}</p>
 </div>
 {item.status === 'pending' && (
 <AlertTriangle size={14} className="text-amber-400/60 flex-shrink-0" />
 )}
 </div>
 </GlassPanel>
 ))}
 </div>
 </motion.div>

 {/* Conversations Preview */}
 <motion.div
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: 0.4 }}
 className="px-5 mb-6"
 >
 <div className="flex items-center justify-between mb-3">
 <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
 Recent Conversations
 </h2>
 <Link href="/dashboard/converse">
 <span className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
 View all
 </span>
 </Link>
 </div>
 <GlassPanel padding="sm">
 {messages.length === 0 ? (
 <p className="text-xs text-slate-500 text-center py-4">
 No conversations yet. Start a conversation!
 </p>
 ) : (
 <div className="space-y-3">
 {messages.slice(-3).map((msg) => (
 <div
 key={msg.id}
 className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
 >
 <div
 className={`
 max-w-[80%] px-3 py-2 rounded-xl text-xs leading-relaxed
 ${
 msg.role === 'user'
 ? 'bg-indigo-500/15 text-indigo-200 rounded-br-sm'
 : 'bg-white/[0.04] text-slate-300 rounded-bl-sm'
 }
 `}
 >
 <p className="font-medium text-[10px] text-slate-500 mb-0.5">
 {msg.role === 'user' ? 'You' : 'NOVA'}
 </p>
 <p>{msg.content}</p>
 </div>
 </div>
 ))}
 </div>
 )}
 </GlassPanel>
 </motion.div>
 </div>
 );
}
