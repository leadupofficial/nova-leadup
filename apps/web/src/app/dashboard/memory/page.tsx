'use client';

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Plus, MoreHorizontal, Eye, Edit3, Trash2, Tag } from 'lucide-react';
import { GlassPanel, GlassButton } from '../../components/glass';
import { Badge } from '../../components/ui/Badge';
import { useMemoryStore } from '../../stores/memory-store';
import { MemoryType } from '../../stores/memory-store';
import { animations } from '../../lib/animations';

const MEMORY_TYPE_CONFIG: Record<MemoryType, { emoji: string; label: string; color: string }> = {
 preference: { emoji: '⚙️', label: 'Preference', color: '#6366f1' },
 fact: { emoji: 'ℹ️', label: 'Fact', color: '#64748b' },
 event: { emoji: '📅', label: 'Event', color: '#22d3ee' },
 task: { emoji: '📝', label: 'Task', color: '#f59e0b' },
 reminder: { emoji: '🔔', label: 'Reminder', color: '#8b5cf6' },
 person: { emoji: '👤', label: 'Person', color: '#10b981' },
 company: { emoji: '🏢', label: 'Company', color: '#6366f1' },
 project: { emoji: '🎯', label: 'Project', color: '#22d3ee' },
 decision: { emoji: '✅', label: 'Decision', color: '#10b981' },
 conversation: { emoji: '💬', label: 'Conversation', color: '#8b5cf6' },
};

const CATEGORIES: (MemoryType | 'all')[] = [
 'all',
 'preference',
 'person',
 'project',
 'event',
 'decision',
 'conversation',
];

export default function MemoryScreen() {
 const { memories, removeMemory } = useMemoryStore();
 const [searchQuery, setSearchQuery] = useState('');
 const [activeCategory, setActiveCategory] = useState<MemoryType | 'all'>('all');

 const filtered = useMemo(() => {
 let result = memories;

 if (searchQuery.trim()) {
 const q = searchQuery.toLowerCase();
 result = result.filter(
 (m) =>
 m.content.toLowerCase().includes(q) ||
 m.type.toLowerCase().includes(q) ||
 m.tags?.some((t) => t.toLowerCase().includes(q)),
 );
 }

 if (activeCategory !== 'all') {
 result = result.filter((m) => m.type === activeCategory);
 }

 return result.sort((a, b) => b.importance - a.importance);
 }, [memories, searchQuery, activeCategory]);

 const categoryStats = useMemo(() => {
 const stats: Record<string, number> = {};
 memories.forEach((m) => {
 stats[m.type] = (stats[m.type] || 0) + 1;
 });
 return stats;
 }, [memories]);

 return (
 <div className="min-h-screen">
 {/* Header */}
 <div className="px-5 pt-6 pb-4">
 <div className="flex items-center justify-between">
 <div>
 <h1 className="text-xl font-bold text-white">Memory</h1>
 <p className="text-xs text-slate-500 mt-0.5">
 {memories.length} memories stored
 </p>
 </div>
 <motion.button
 whileTap={{ scale: 0.92 }}
 className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-400/20
 flex items-center justify-center text-indigo-400 hover:bg-indigo-500/25 transition-colors"
 aria-label="Add memory"
 >
 <Plus size={18} />
 </motion.button>
 </div>
 </div>

 {/* Search */}
 <div className="px-5 mb-4">
 <div className="relative">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
 <input
 type="text"
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 placeholder="Search memories..."
 className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm text-white placeholder-slate-500
 bg-white/[0.04] border border-white/[0.08]
 focus:outline-none focus:border-indigo-400/40 focus:bg-white/[0.07] transition-colors"
 />
 </div>
 </div>

 {/* Category chips */}
 <div className="px-5 mb-4 overflow-x-auto scrollbar-hide">
 <div className="flex gap-2">
 {CATEGORIES.map((cat) => {
 const isActive = activeCategory === cat;
 const label = cat === 'all' ? 'All' : MEMORY_TYPE_CONFIG[cat]?.label || cat;
 const count = cat === 'all' ? memories.length : categoryStats[cat] || 0;

 return (
 <button
 key={cat}
 onClick={() => setActiveCategory(cat)}
 className={`
 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-200 cursor-pointer
 ${
 isActive
 ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-400/30'
 : 'bg-white/[0.04] text-slate-400 border border-white/[0.06] hover:bg-white/[0.08]'
 }
 `}
 >
 {label}
 <span className="ml-1 text-[10px] opacity-60">{count}</span>
 </button>
 );
 })}
 </div>
 </div>

 {/* Memory Stats */}
 <div className="px-5 mb-4">
 <GlassPanel padding="sm">
 <div className="flex items-center justify-between">
 <div>
 <p className="text-xs text-slate-500">Memory Health</p>
 <p className="text-lg font-bold text-white mt-0.5">{memories.length} total</p>
 </div>
 <div className="flex items-center gap-3 text-xs">
 <div>
 <p className="text-emerald-400 font-medium">
 {memories.filter((m) => m.importance > 0.7).length}
 </p>
 <p className="text-slate-600">High</p>
 </div>
 <div>
 <p className="text-amber-400 font-medium">
 {memories.filter((m) => m.importance > 0.4 && m.importance <= 0.7).length}
 </p>
 <p className="text-slate-600">Medium</p>
 </div>
 <div>
 <p className="text-slate-500 font-medium">
 {memories.filter((m) => m.importance <= 0.4).length}
 </p>
 <p className="text-slate-600">Low</p>
 </div>
 </div>
 </div>
 </GlassPanel>
 </div>

 {/* Memory List */}
 <div className="px-5 space-y-2">
 <AnimatePresence mode="popLayout">
 {filtered.map((memory, index) => {
 const config = MEMORY_TYPE_CONFIG[memory.type] || {
 emoji: '📄',
 label: memory.type,
 color: '#64748b',
 };

 return (
 <motion.div
 key={memory.id}
 initial={{ opacity: 0, y: 8 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: -4 }}
 transition={{ delay: index * 0.04 }}
 >
 <GlassPanel padding="md" hoverable>
 <div className="flex gap-3">
 <div
 className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-lg"
 style={{ background: `${config.color}15` }}
 >
 {config.emoji}
 </div>
 <div className="flex-1 min-w-0">
 <div className="flex items-start justify-between gap-2">
 <div>
 <h3 className="text-sm font-semibold text-white">{memory.type}</h3>
 <p className="text-xs text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">
 {memory.content}
 </p>
 </div>
 <div className="flex items-center gap-1 flex-shrink-0">
 {[Eye, Edit3, Trash2].map((Icon, i) => (
 <motion.button
 key={i}
 whileTap={{ scale: 0.85 }}
 onClick={() => i === 2 && removeMemory(memory.id)}
 className="p-1.5 rounded-lg text-slate-600 hover:text-slate-400 hover:bg-white/[0.04] transition-colors"
 aria-label={['View', 'Edit', 'Delete'][i]}
 >
 <Icon size={14} />
 </motion.button>
 ))}
 </div>
 </div>
 <div className="flex items-center gap-2 mt-2">
 <span className="text-[10px] text-slate-600">
 {new Date(memory.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
 </span>
 {memory.tags?.slice(0, 2).map((tag) => (
 <span
 key={tag}
 className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.04] text-slate-500"
 >
 {tag}
 </span>
 ))}
 </div>
 </div>
 </div>
 </GlassPanel>
 </motion.div>
 );
 })}
 </AnimatePresence>

 {filtered.length === 0 && (
 <motion.div
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 className="text-center py-12"
 >
 <div className="text-4xl mb-3">🔍</div>
 <p className="text-sm text-slate-500">
 {searchQuery ? 'No memories match your search.' : 'No memories yet.'}
 </p>
 </motion.div>
 )}
 </div>
 </div>
 );
}
