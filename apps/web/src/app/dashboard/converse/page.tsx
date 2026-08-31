'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
 Mic,
 MicOff,
 Send,
 Volume2,
 VolumeX,
 StopCircle,
 Sparkles,
 ChevronDown,
 CalendarPlus,
 Search,
 FileText,
 MessageSquare,
} from 'lucide-react';
import { Avatar } from '../../../components/avatar/Avatar';
import { GlassPanel } from '../../../components/glass/GlassPanel';
import { GlassButton } from '../../../components/glass/GlassButton';
import { VoiceWaveform } from '../../../components/glass/VoiceWaveform';
import { useAssistantStore } from '../../../stores/assistant-store';
import { useConversationStore } from '../../../stores/conversation-store';
import { useVoice } from '../../../hooks/use-voice';
import { useAssistant } from '../../../hooks/use-assistant';
import { animations } from '../../../lib/animations';
import { cn } from '../../../lib/utils';

const QUICK_ACTIONS = [
 { label: 'Create Task', icon: CalendarPlus, color: '#6366f1' },
 { label: 'Set Reminder', icon: CalendarPlus, color: '#f59e0b' },
 { label: 'Search Memory', icon: Search, color: '#22d3ee' },
 { label: 'Record Note', icon: FileText, color: '#10b981' },
 { label: 'Translate', icon: MessageSquare, color: '#8b5cf6' },
];

export default function ConverseScreen() {
 const { state, setState } = useAssistantStore();
 const { messages, isStreaming, clearMessages } = useConversationStore();
 const { sendMessage, cancelProcessing, toggleListening } = useAssistant();
 const { transcript, interimTranscript, startVoiceInput, stopVoiceInput, volume } = useVoice();
 const [inputText, setInputText] = useState('');
 const [isMuted, setIsMuted] = useState(false);
 const [showQuickActions, setShowQuickActions] = useState(false);
 const messagesEndRef = useRef<HTMLDivElement>(null);

 const isListening = state === 'listening';

 useEffect(() => {
 messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
 }, [messages, transcript]);

 const handleSend = () => {
 if (!inputText.trim()) return;
 const text = inputText;
 setInputText('');
 sendMessage(text);
 };

 const handleVoiceToggle = () => {
 if (isListening) {
 stopVoiceInput();
 setState('idle');
 } else {
 startVoiceInput();
 }
 };

 const handleTranscriptSend = () => {
 if (transcript) {
 sendMessage(transcript);
 }
 };

 return (
 <div className="min-h-screen flex flex-col">
 {/* Header */}
 <div className="px-5 pt-6 pb-3 flex items-center justify-between">
 <div>
 <h1 className="text-xl font-bold text-white">Converse</h1>
 <p className="text-xs text-slate-500 mt-0.5">
 {messages.length > 0 ? `${messages.length} messages` : 'Start a conversation'}
 </p>
 </div>
 <div className="flex items-center gap-2">
 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={() => setIsMuted(!isMuted)}
 className="p-2 rounded-xl bg-white/[0.04] border border-white/[0.08]"
 aria-label={isMuted ? 'Unmute' : 'Mute'}
 >
 {isMuted ? <VolumeX size={18} className="text-slate-400" /> : <Volume2 size={18} className="text-slate-400" />}
 </motion.button>
 {messages.length > 0 && (
 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={clearMessages}
 className="p-2 rounded-xl bg-white/[0.04] border border-white/[0.08]"
 aria-label="Clear conversation"
 >
 <StopCircle size={18} className="text-slate-400" />
 </motion.button>
 )}
 </div>
 </div>

 {/* Messages Area */}
 <div className="flex-1 overflow-y-auto px-5 pb-4">
 {messages.length === 0 && !transcript ? (
 <motion.div
 initial={{ opacity: 0, y: 20 }}
 animate={{ opacity: 1, y: 0 }}
 className="flex flex-col items-center justify-center pt-20 text-center"
 >
 <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500/20 to-cyan-400/20
 flex items-center justify-center mb-4 border border-white/[0.08]">
 <Sparkles size={32} className="text-indigo-400" />
 </div>
 <h3 className="text-lg font-semibold text-white mb-2">How can I help?</h3>
 <p className="text-sm text-slate-500 max-w-[260px]">
 Ask me anything, set reminders, or just have a conversation.
 </p>
 </motion.div>
 ) : (
 <div className="space-y-3">
 <AnimatePresence mode="popLayout">
 {messages.map((msg, index) => (
 <motion.div
 key={msg.id}
 initial={{ opacity: 0, y: 8, scale: 0.97 }}
 animate={{ opacity: 1, y: 0, scale: 1 }}
 transition={{ delay: index * 0.03 }}
 className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
 >
 <GlassPanel
 padding="md"
 className={cn(
 'max-w-[85%]',
 msg.role === 'user'
 ? 'bg-indigo-500/10 border-indigo-400/15'
 : 'bg-white/[0.03]',
 )}
 >
 <p className="text-[10px] font-medium text-slate-500 mb-1">
 {msg.role === 'user' ? 'You' : 'NOVA'}
 </p>
 <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
 {msg.content}
 </p>
 </GlassPanel>
 </motion.div>
 ))}
 </AnimatePresence>

 {/* Streaming indicator */}
 <AnimatePresence>
 {isStreaming && (
 <motion.div
 initial={{ opacity: 0, y: 8 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: -8 }}
 className="flex justify-start"
 >
 <GlassPanel padding="md" className="max-w-[85%]">
 <div className="flex items-center gap-2">
 <VoiceWaveform state={state} height={20} barCount={16} />
 <span className="text-xs text-slate-500">NOVA is speaking...</span>
 </div>
 </GlassPanel>
 </motion.div>
 )}
 </AnimatePresence>

 <div ref={messagesEndRef} />
 </div>
 )}

 {/* Voice Input Overlay */}
 <AnimatePresence>
 {(isListening || transcript) && (
 <motion.div
 initial={{ opacity: 0, y: 20 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: 20 }}
 className="mt-4"
 >
 <GlassPanel glow padding="lg" className="text-center">
 <VoiceWaveform state={state} height={48} barCount={32} />
 <p className="text-sm text-slate-400 mt-3">
 {transcript ? 'Hearing you...' : 'Listening...'}
 </p>
 {transcript && (
 <>
 <p className="text-base text-white mt-2 font-medium">{transcript}</p>
 {interimTranscript && (
 <p className="text-sm text-slate-500 mt-1 italic">{interimTranscript}</p>
 )}
 </>
 )}
 <div className="flex items-center justify-center gap-3 mt-4">
 <GlassButton variant="secondary" size="sm" onClick={stopVoiceInput}>
 Cancel
 </GlassButton>
 {transcript && (
 <GlassButton variant="primary" size="sm" onClick={handleTranscriptSend}>
 <Send size={16} />
 Send
 </GlassButton>
 )}
 </div>
 </GlassPanel>
 </motion.div>
 )}
 </AnimatePresence>
 </div>

 {/* Bottom Controls */}
 <div className="sticky bottom-0 px-5 pt-3 pb-6 bg-gradient-to-t from-[#0b1020] via-[#0b1020] to-transparent">
 {/* Quick Actions Row */}
 <motion.div
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 className={cn('transition-all duration-200 overflow-hidden', showQuickActions ? 'mb-3' : 'h-0')}
 >
 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
 {QUICK_ACTIONS.map((action) => {
 const Icon = action.icon;
 return (
 <motion.button
 key={action.label}
 whileTap={{ scale: 0.95 }}
 className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/[0.04]
 border border-white/[0.08] text-xs text-slate-400 whitespace-nowrap
 hover:bg-white/[0.08] transition-colors"
 >
 <div
 className="w-6 h-6 rounded-md flex items-center justify-center"
 style={{ background: `${action.color}15` }}
 >
 <Icon size={12} style={{ color: action.color }} />
 </div>
 {action.label}
 </motion.button>
 );
 })}
 </div>
 </motion.div>

 {/* Input Bar */}
 <div className="flex items-center gap-2">
 <input
 type="text"
 value={inputText}
 onChange={(e) => setInputText(e.target.value)}
 onKeyDown={(e) => e.key === 'Enter' && handleSend()}
 placeholder="Type a message..."
 disabled={isStreaming}
 className={cn(
 'flex-1 px-4 py-3 rounded-2xl text-sm text-white placeholder-slate-500',
 'bg-white/[0.05] border border-white/[0.08]',
 'focus:outline-none focus:border-indigo-400/40 focus:bg-white/[0.07]',
 'disabled:opacity-50 transition-colors',
 )}
 />
 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={() => setShowQuickActions(!showQuickActions)}
 className="p-3 rounded-2xl bg-white/[0.05] border border-white/[0.08]
 hover:bg-white/[0.08] transition-colors flex-shrink-0"
 aria-label="Quick actions"
 >
 <ChevronDown
 size={20}
 className={cn('text-slate-400 transition-transform duration-200', showQuickActions && 'rotate-180')}
 />
 </motion.button>
 <GlassButton
 variant="primary"
 size="md"
 onClick={handleSend}
 disabled={!inputText.trim() || isStreaming}
 aria-label="Send message"
 >
 <Send size={18} />
 </GlassButton>
 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={handleVoiceToggle}
 className={cn(
 'p-3 rounded-2xl flex-shrink-0 transition-all duration-200',
 isListening
 ? 'bg-cyan-500/15 border-2 border-cyan-400/40'
 : 'bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.08]',
 )}
 aria-label={isListening ? 'Stop listening' : 'Start listening'}
 >
 {isListening ? (
 <MicOff size={20} className="text-cyan-400" />
 ) : (
 <Mic size={20} className="text-slate-400" />
 )}
 </motion.button>
 </div>
 </div>
 </div>
 );
}
