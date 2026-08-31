"use client";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Plus, MoreHorizontal, Eye, Edit3, Trash2 } from "lucide-react";
import { GlassPanel } from "../../../components/ui/GlassPanel";
import { Badge } from "../../../components/ui/Badge";
import { mockMemories, categoryMeta } from "../../../lib/mock-data";
import type { Memory } from "../../../lib/mock-data";

const categories = ["all", ...Object.keys(categoryMeta)];

export default function MemoryScreen() {
 const [searchQuery, setSearchQuery] = useState("");
 const [activeCategory, setActiveCategory] = useState("all");

 const filtered = useMemo(() => {
 let result = mockMemories;

 if (searchQuery.trim()) {
 const q = searchQuery.toLowerCase();
 result = result.filter(
 (m) =>
 m.title.toLowerCase().includes(q) ||
 m.description.toLowerCase().includes(q) ||
 m.tags?.some((t) => t.toLowerCase().includes(q)),
 );
 }

 if (activeCategory !== "all") {
 result = result.filter((m) => m.category === activeCategory);
 }

 return result.sort((a, b) => b.importance - a.importance);
 }, [searchQuery, activeCategory]);

 const confidenceLabel = (c: number) => {
 if (c >= 0.9) return { text: "High", variant: "success" as const };
 if (c >= 0.75) return { text: "Medium", variant: "warning" as const };
 return { text: "Low", variant: "danger" as const };
 };

 return (
 <div>
 {/* Header */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
 <h1 style={{fontSize: '24px', fontWeight: 'bold', color: '#f8fafc'}}>
 Your Memories ({mockMemories.length})
 </h1>
 <button
 style={{width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1'}}
 aria-label="Add memory"
 >
 <Plus size={18} />
 </button>
 </div>

 {/* Search */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <div>
 <Search size={16} style={{color: '#64748b'}} />
 <input
 type="text"
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 placeholder="Search memories..."
 style={{width: '100%', borderRadius: '12px', fontSize: '14px', color: '#f8fafc'}}
 />
 </div>
 </div>

 {/* Filter chips */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', display: 'flex', gap: '8px'}}>
 {categories.map((cat) => {
 const isActive = activeCategory === cat;
 const label = cat === "all" ? "All" : categoryMeta[cat]?.label || cat;

 return (
 <button
 key={cat}
 onClick={() => setActiveCategory(cat)}
 className={`
 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap cursor-pointer
 transition-all duration-200
 ${isActive
 ? "bg-nova-primary/20 text-nova-primary border border-nova-primary/30"
 : "bg-nova-surface/60 text-nova-text-muted border border-transparent hover:text-nova-text"
 }
 `}
 >
 {label}
 </button>
 );
 })}
 </div>

 {/* Memory list */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <AnimatePresence mode="popLayout">
 {filtered.map((memory, index) => {
 const meta = categoryMeta[memory.category] || { emoji: "📄", label: memory.category, color: "text-nova-text-muted" };
 const conf = confidenceLabel(memory.confidence);

 return (
 <motion.div
 key={memory.id}
 initial={{ opacity: 0, y: 12 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: -8 }}
 transition={{ delay: index * 0.04 }}
 >
 <GlassPanel padding="md">
 <div style={{display: 'flex', gap: '12px'}}>
 <span style={{fontSize: '24px', fontWeight: 'bold'}}>{meta.emoji}</span>
 <div>
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <h3 style={{fontSize: '14px', fontWeight: '600', color: '#f8fafc'}}>{memory.title}</h3>
 <Badge variant={conf.variant} size="sm" dot>
 {conf.text}
 </Badge>
 </div>
 <p style={{fontSize: '12px', color: '#94a3b8', marginTop: '4px'}}>
 {memory.description}
 </p>
 <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px'}}>
 <span style={{color: '#64748b'}}>
 {memory.sourceType} · {memory.createdAt}
 </span>
 {memory.tags?.map((tag) => (
 <span
 key={tag}
 style={{color: '#64748b'}}
 >
 #{tag}
 </span>
 ))}
 </div>
 </div>
 <div style={{display: 'flex', alignItems: 'center'}}>
 {[Eye, Edit3, Trash2].map((Icon, i) => (
 <button
 key={i}
 style={{borderRadius: '8px', color: '#64748b'}}
 aria-label={["View", "Edit", "Delete"][i]}
 >
 <Icon size={14} />
 </button>
 ))}
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
 style={{color: '#64748b', fontSize: '14px'}}
 >
 No memories match your search.
 </motion.div>
 )}
 </div>
 </div>
 );
}
