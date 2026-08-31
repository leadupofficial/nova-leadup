'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronRight, Plus, Calendar, Clock, Repeat } from 'lucide-react';
import { GlassPanel, GlassButton } from '../../components/glass';
import { Badge } from '../../components/ui/Badge';
import { useTaskStore } from '../../stores/task-store';
import { animations } from '../../lib/animations';
import { cn } from '../../lib/utils';

type TabType = 'tasks' | 'reminders';
type TaskFilter = 'all' | 'active' | 'completed';

const PRIORITY_CONFIG = {
 high: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', label: 'High' },
 medium: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', label: 'Medium' },
 low: { color: '#22d3ee', bg: 'rgba(34,211,238,0.12)', label: 'Low' },
};

export default function TasksScreen() {
 const { tasks, reminders, addTask, toggleTask, deleteTask, addReminder } = useTaskStore();
 const [activeTab, setActiveTab] = useState<TabType>('tasks');
 const [taskFilter, setTaskFilter] = useState<TaskFilter>('active');
 const [newTaskTitle, setNewTaskTitle] = useState('');
 const [showAddTask, setShowAddTask] = useState(false);

 const filteredTasks = tasks.filter((t) => {
 if (taskFilter === 'active') return !t.completed;
 if (taskFilter === 'completed') return t.completed;
 return true;
 });

 const pendingCount = tasks.filter((t) => !t.completed).length;
 const completedCount = tasks.filter((t) => t.completed).length;

 const handleAddTask = () => {
 if (!newTaskTitle.trim()) return;
 addTask({
 title: newTaskTitle.trim(),
 completed: false,
 priority: 'medium',
 category: 'work',
 });
 setNewTaskTitle('');
 setShowAddTask(false);
 };

 const getCategoryColor = (cat: string) => {
 switch (cat) {
 case 'work': return '#6366f1';
 case 'personal': return '#22d3ee';
 case 'meeting': return '#f59e0b';
 case 'follow-up': return '#10b981';
 default: return '#64748b';
 }
 };

 return (
 <div className="min-h-screen">
 {/* Header */}
 <div className="px-5 pt-6 pb-4">
 <h1 className="text-xl font-bold text-white">Tasks</h1>
 <p className="text-xs text-slate-500 mt-0.5">
 {pendingCount} active · {completedCount} completed
 </p>
 </div>

 {/* Tab Switcher */}
 <div className="px-5 mb-4">
 <div className="flex bg-white/[0.04] rounded-xl p-1 border border-white/[0.08]">
 {(['tasks', 'reminders'] as TabType[]).map((tab) => (
 <button
 key={tab}
 onClick={() => setActiveTab(tab)}
 className={`
 flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer
 ${
 activeTab === tab
 ? 'bg-white/[0.08] text-white shadow-sm'
 : 'text-slate-500 hover:text-slate-400'
 }
 `}
 >
 {tab === 'tasks' ? `Tasks (${pendingCount})` : `Reminders (${reminders.length})`}
 </button>
 ))}
 </div>
 </div>

 {activeTab === 'tasks' && (
 <>
 {/* Task Filters */}
 <div className="px-5 mb-4">
 <div className="flex gap-2">
 {(['all', 'active', 'completed'] as TaskFilter[]).map((filter) => {
 const counts: Record<TaskFilter, number> = {
 all: tasks.length,
 active: pendingCount,
 completed: completedCount,
 };
 return (
 <button
 key={filter}
 onClick={() => setTaskFilter(filter)}
 className={`
 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer
 ${
 taskFilter === filter
 ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-400/25'
 : 'bg-white/[0.03] text-slate-500 border border-transparent hover:text-slate-400'
 }
 `}
 >
 {filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Done'} ({counts[filter]})
 </button>
 );
 })}
 </div>
 </div>

 {/* Add Task */}
 <AnimatePresence>
 {showAddTask && (
 <motion.div
 initial={{ opacity: 0, height: 0 }}
 animate={{ opacity: 1, height: 'auto' }}
 exit={{ opacity: 0, height: 0 }}
 className="px-5 mb-3"
 >
 <GlassPanel padding="md" className="border-indigo-400/15">
 <input
 type="text"
 value={newTaskTitle}
 onChange={(e) => setNewTaskTitle(e.target.value)}
 onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
 placeholder="What needs to be done?"
 autoFocus
 className="w-full bg-transparent text-sm text-white placeholder-slate-500
 focus:outline-none mb-3"
 />
 <div className="flex gap-2">
 <select
 className="text-xs bg-white/[0.05] border border-white/[0.08] rounded-lg px-2 py-1.5
 text-slate-400 focus:outline-none"
 >
 <option>High priority</option>
 <option>Medium</option>
 <option>Low</option>
 </select>
 <GlassButton variant="primary" size="sm" onClick={handleAddTask}>
 <Plus size={14} />
 Add
 </GlassButton>
 </div>
 </GlassPanel>
 </motion.div>
 )}
 </AnimatePresence>

 {/* Task List */}
 <div className="px-5 space-y-2">
 <AnimatePresence mode="popLayout">
 {filteredTasks.map((task, index) => {
 const priorityConfig = PRIORITY_CONFIG[task.priority];

 return (
 <motion.div
 key={task.id}
 initial={{ opacity: 0, x: -8 }}
 animate={{ opacity: 1, x: 0 }}
 exit={{ opacity: 0, x: 8 }}
 transition={{ delay: index * 0.04 }}
 >
 <GlassPanel
 padding="md"
 className={cn(
 'transition-opacity duration-200',
 task.completed && 'opacity-50',
 )}
 >
 <div className="flex gap-3">
 <motion.button
 whileTap={{ scale: 0.85 }}
 onClick={() => toggleTask(task.id)}
 className={`
 mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center
 flex-shrink-0 cursor-pointer transition-all duration-200
 ${
 task.completed
 ? 'bg-emerald-500 border-emerald-500'
 : 'border-slate-600 hover:border-indigo-400'
 }
 `}
 aria-label={task.completed ? 'Mark as pending' : 'Mark as completed'}
 >
 {task.completed && <Check size={12} className="text-white" />}
 </motion.button>

 <div className="flex-1 min-w-0">
 <div className="flex items-start justify-between gap-2">
 <div>
 <h3
 className={`
 text-sm font-medium leading-snug
 ${task.completed ? 'text-slate-500 line-through' : 'text-slate-200'}
 `}
 >
 {task.title}
 </h3>
 <div className="flex items-center gap-2 mt-1">
 <span
 className="text-[10px] font-medium px-1.5 py-0.5 rounded-md"
 style={{ background: priorityConfig.bg, color: priorityConfig.color }}
 >
 {priorityConfig.label}
 </span>
 <span className="text-[10px] text-slate-600 flex items-center gap-0.5">
 <Clock size={10} />
 {task.dueDate}
 </span>
 {task.tags.map((tag) => (
 <span
 key={tag}
 className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.04] text-slate-500"
 >
 {tag}
 </span>
 ))}
 </div>
 </div>
 {!task.completed && (
 <motion.button
 whileTap={{ scale: 0.85 }}
 onClick={() => deleteTask(task.id)}
 className="p-1 text-slate-700 hover:text-red-400 transition-colors"
 aria-label="Delete task"
 >
 <ChevronRight size={16} />
 </motion.button>
 )}
 </div>
 </div>
 </div>
 </GlassPanel>
 </motion.div>
 );
 })}
 </AnimatePresence>

 {filteredTasks.length === 0 && (
 <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-12">
 <div className="text-4xl mb-3">📋</div>
 <p className="text-sm text-slate-500">
 {taskFilter === 'completed' ? 'No completed tasks yet.' : taskFilter === 'active' ? 'No active tasks!' : 'No tasks yet.'}
 </p>
 {taskFilter !== 'completed' && (
 <GlassButton variant="secondary" size="sm" className="mt-3" onClick={() => setShowAddTask(true)}>
 <Plus size={14} />
 Add Task
 </GlassButton>
 )}
 </motion.div>
 )}
 </div>
 </>
 )}

 {activeTab === 'reminders' && (
 <div className="px-5 space-y-2">
 <AnimatePresence>
 {reminders.map((reminder, index) => (
 <motion.div
 key={reminder.id}
 initial={{ opacity: 0, y: 8 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: -4 }}
 transition={{ delay: index * 0.04 }}
 >
 <GlassPanel padding="md" hoverable>
 <div className="flex gap-3">
 <div className="w-9 h-9 rounded-lg bg-amber-500/12 flex items-center justify-center flex-shrink-0">
 <Clock size={18} className="text-amber-400" />
 </div>
 <div className="flex-1">
 <h3 className="text-sm font-medium text-white">{reminder.title}</h3>
 <div className="flex items-center gap-2 mt-1">
 <Calendar size={12} className="text-slate-600" />
 <span className="text-xs text-slate-500">
 {new Date(reminder.datetime).toLocaleString('en-US', {
 month: 'short',
 day: 'numeric',
 hour: 'numeric',
 minute: '2-digit',
 })}
 </span>
 </div>
 {reminder.recurring && (
 <div className="flex items-center gap-1 mt-1">
 <Repeat size={12} className="text-cyan-500" />
 <span className="text-[10px] text-cyan-400 capitalize">{reminder.recurringPattern}</span>
 </div>
 )}
 </div>
 </div>
 </GlassPanel>
 </motion.div>
 ))}

 {reminders.length === 0 && (
 <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-12">
 <div className="text-4xl mb-3">🔔</div>
 <p className="text-sm text-slate-500">No reminders set.</p>
 <GlassButton variant="secondary" size="sm" className="mt-3">
 <Plus size={14} />
 Add Reminder
 </GlassButton>
 </motion.div>
 )}
 </AnimatePresence>
 </div>
 )}

 {/* Floating Add Button */}
 <div className="fixed bottom-24 right-5">
 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={() => setShowAddTask(!showAddTask)}
 className={`
 w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-200
 bg-gradient-to-r from-indigo-500 to-cyan-400 text-white shadow-indigo-500/25
 hover:shadow-xl hover:shadow-indigo-500/30
 `}
 aria-label={showAddTask ? 'Cancel' : 'Add task'}
 >
 <Plus size={22} />
 </motion.button>
 </div>
 </div>
 );
}
