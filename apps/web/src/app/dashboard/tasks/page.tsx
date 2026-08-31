"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { GlassPanel } from "../../../components/ui/GlassPanel";
import { Badge } from "../../../components/ui/Badge";
import { mockTasks } from "../../../lib/mock-data";

type Section = "today" | "upcoming" | "overdue";

const sectionMeta: Record<Section, { label: string; color: string }> = {
 today: { label: "Today", color: "primary" },
 upcoming: { label: "Upcoming", color: "accent" },
 overdue: { label: "Overdue", color: "danger" },
};

export default function TasksScreen() {
 const [tasks, setTasks] = useState(mockTasks);
 const [activeTab, setActiveTab] = useState<Section>("today");

 const toggleTask = (id: string) => {
 setTasks((prev) =>
 prev.map((task) =>
 task.id === id
 ? { ...task, status: task.status === "completed" ? "pending" : "completed" }
 : task,
 ),
 );
 };

 const visibleTasks = tasks.filter((t) => t.section === activeTab);

 return (
 <div>
 {/* Header */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <h1 style={{fontSize: '24px', fontWeight: 'bold', color: '#f8fafc'}}>
 Tasks ({tasks.filter((t) => t.status !== "completed").length} pending)
 </h1>
 </div>

 {/* Tabs */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', display: 'flex', gap: '8px'}}>
 {(Object.keys(sectionMeta) as Section[]).map((section) => {
 const meta = sectionMeta[section];
 const count = tasks.filter((t) => t.section === section).length;
 const isActive = activeTab === section;

 return (
 <button
 key={section}
 onClick={() => setActiveTab(section)}
 className={
 "px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer " +
 (isActive
 ? "bg-primary/15 text-nova-primary"
 : "bg-nova-surface/60 text-nova-text-muted hover:text-nova-text")
 }
 style={isActive ? { backgroundColor: "rgba(99,102,241,0.15)", color: "#6366F1" } : {}}
 >
 {meta.label} ({count})
 </button>
 );
 })}
 </div>

 {/* Task list */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 {visibleTasks.length === 0 && (
 <div style={{color: '#64748b', fontSize: '14px'}}>
 No tasks in this section.
 </div>
 )}

 <AnimatePresence mode="popLayout">
 {visibleTasks.map((task, index) => (
 <motion.div
 key={task.id}
 initial={{ opacity: 0, x: -12 }}
 animate={{ opacity: 1, x: 0 }}
 exit={{ opacity: 0, x: 12 }}
 transition={{ delay: index * 0.05 }}
 >
 <GlassPanel padding="md" className={task.status === "completed" ? "opacity-60" : ""}>
 <div style={{display: 'flex', gap: '12px'}}>
 {/* Checkbox */}
 <button
 onClick={() => toggleTask(task.id)}
 className={
 "mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 cursor-pointer transition-all duration-200 " +
 (task.status === "completed"
 ? "bg-nova-success border-nova-success"
 : "border-nova-text-dim hover:border-nova-primary")
 }
 aria-label={task.status === "completed" ? "Mark as pending" : "Mark as completed"}
 >
 {task.status === "completed" && <Check size={12} />}
 </button>

 <div>
 <h3
 className={
 "text-sm font-medium " +
 (task.status === "completed"
 ? "text-nova-text-dim line-through"
 : "text-nova-text")
 }
 >
 {task.title}
 </h3>
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <span style={{fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center'}}>
 {task.dueDate}
 {task.dueTime && <span style={{color: '#64748b'}}> - {task.dueTime}</span>}
 </span>
 </div>
 <div style={{display: 'flex', marginTop: '8px'}}>
 {task.tags.map((tag) => (
 <span
 key={tag}
 style={{borderRadius: '50%', color: '#6366f1', fontWeight: '500'}}
 >
 {tag}
 </span>
 ))}
 {task.source === "voice" && (
 <Badge variant="accent" size="sm" dot>
 Voice
 </Badge>
 )}
 {task.source === "meeting" && (
 <Badge variant="secondary" size="sm" dot>
 Meeting
 </Badge>
 )}
 </div>
 </div>

 {task.status !== "completed" && (
 <ChevronRight size={16} style={{color: '#64748b', marginTop: '4px'}} />
 )}
 </div>
 </GlassPanel>
 </motion.div>
 ))}
 </AnimatePresence>
 </div>
 </div>
 );
}