"use client";

import { motion } from "framer-motion";
import { Bell, Mic, MessageSquare } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { GlassPanel } from "../../components/ui/GlassPanel";
import { Badge } from "../../components/ui/Badge";
import { overviewStats, mockReminders } from "../../lib/mock-data";

const hour = new Date().getHours();
const greeting =
 hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
const dateStr = new Date().toLocaleDateString("en-US", {
 weekday: "long",
 month: "short",
 day: "numeric",
 });

const container = {
 hidden: { opacity: 0 },
 show: {
 opacity: 1,
 transition: { staggerChildren: 0.08 },
 },
};

const item = {
 hidden: { opacity: 0, y: 16 },
 show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function DashboardHome() {
 return (
 <motion.div
 variants={container}
 initial="hidden"
 animate="show"
 >
 {/* Header */}
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: '16px', paddingRight: '16px'}}>
 <div>
 <motion.h1 variants={item} style={{fontSize: '24px', fontWeight: 'bold', color: '#f8fafc'}}>
 {greeting}, Abishek
 </motion.h1>
 <motion.p variants={item} style={{fontSize: '14px', color: '#94a3b8'}}>
 {dateStr}
 </motion.p>
 </div>
 <div style={{display: 'flex', gap: '12px'}}>
 <motion.div variants={item}>
 <Bell size={20} style={{color: '#94a3b8'}} />
 <span style={{width: '16px', height: '16px', background: '#ef4444', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold'}}>
 {mockReminders.length}
 </span>
 </motion.div>
 <motion.div variants={item}>
 <div style={{width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '14px'}}>
 A
 </div>
 </motion.div>
 </div>
 </div>

 {/* Avatar Area */}
 <motion.div variants={item} style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
 {/* Outer rotating ring */}
 <svg
 style={{width: '100%', height: '100%'}}
 viewBox="0 0 160 160"
 >
 <circle
 cx="80"
 cy="80"
 r="74"
 fill="none"
 stroke="url(#avatarRing)"
 strokeWidth="1"
 strokeDasharray="12 6"
 opacity="0.4"
 />
 <defs>
 <linearGradient id="avatarRing" x1="0%" y1="0%" x2="100%" y2="100%">
 <stop offset="0%" stopColor="#6366F1" />
 <stop offset="50%" stopColor="#8B5CF6" />
 <stop offset="100%" stopColor="#22D3EE" />
 </linearGradient>
 </defs>
 </svg>

 {/* Inner glow */}
 <div style={{borderRadius: '50%'}} />

 {/* Avatar circle */}
 <div style={{borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
 <span style={{fontWeight: 'bold'}}>N</span>
 </div>
 </div>

 {/* Status */}
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <span style={{display: 'flex', height: '8px', width: '8px'}}>
 <span style={{height: '100%', width: '100%', borderRadius: '50%', background: '#10b981'}} />
 <span style={{borderRadius: '50%', height: '8px', width: '8px', background: '#10b981'}} />
 </span>
 <span style={{fontSize: '14px', color: '#10b981', fontWeight: '500'}}>Ready</span>
 </div>
 </motion.div>

 {/* Voice CTA */}
 <motion.div variants={item} style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <Button
 variant="accent"
 size="lg"
 style={{width: '100%'}}
 leftIcon={<Mic size={22} />}
 >
 Tap to talk
 </Button>
 <p style={{fontSize: '12px', color: '#64748b', marginTop: '8px'}}>
 or say "Hey Nova"
 </p>
 </motion.div>

 {/* Overview Cards */}
 <motion.div variants={item} style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <h2 style={{fontSize: '18px', fontWeight: '600', color: '#f8fafc'}}>Today&apos;s Overview</h2>
 <div style={{gap: '12px'}}>
 {overviewStats.map((stat) => (
 <GlassPanel key={stat.label} padding="sm">
 <div
 className={`text-2xl font-bold ${
 stat.color === "warning"
 ? "text-nova-warning"
 : stat.color === "primary"
 ? "text-nova-primary"
 : "text-nova-accent"
 }`}
 >
 {stat.count}
 </div>
 <p style={{color: '#94a3b8', marginTop: '4px'}}>{stat.label}</p>
 </GlassPanel>
 ))}
 </div>
 </motion.div>

 {/* Quick insight */}
 <motion.div variants={item} style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <GlassPanel padding="md">
 <p style={{fontSize: '14px', color: '#94a3b8'}}>
 You have {mockReminders.length} reminders today, next at 10:00 AM.
 </p>
 </GlassPanel>
 </motion.div>

 {/* Spacer for nav */}
 <div style={{height: '16px'}} />
 </motion.div>
 );
}
