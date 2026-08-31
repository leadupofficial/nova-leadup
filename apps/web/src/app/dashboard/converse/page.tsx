"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
 Mic,
 MicOff,
 Send,
 StopCircle,
 Volume2,
 VolumeX,
 FileText,
 CalendarPlus,
 Search,
 MessageSquare,
} from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { GlassPanel } from "../../../components/ui/GlassPanel";
import { mockConversation } from "../../../lib/mock-data";

type AvatarState = "idle" | "listening" | "thinking" | "speaking";

const stateConfig: Record<AvatarState, { label: string; dotColor: string; ringColor: string }> = {
 idle: { label: "Idle", dotColor: "bg-nova-text-dim", ringColor: "border-nova-text-dim/20" },
 listening: { label: "Listening...", dotColor: "bg-nova-accent", ringColor: "border-nova-accent/50" },
 thinking: { label: "Thinking...", dotColor: "bg-nova-warning", ringColor: "border-nova-warning/50" },
 speaking: { label: "Speaking", dotColor: "bg-nova-success", ringColor: "border-nova-success/50" },
};

const quickActions = [
 { label: "Create Task", icon: CalendarPlus },
 { label: "Set Reminder", icon: CalendarPlus },
 { label: "Search Memory", icon: Search },
 { label: "Record Meeting", icon: FileText },
 { label: "Translate", icon: MessageSquare },
];

export default function ConverseScreen() {
 const [avatarState, setAvatarState] = useState<AvatarState>("idle");
 const [transcript, setTranscript] = useState(mockConversation);
 const [captionsOn, setCaptionsOn] = useState(true);
 const [muted, setMuted] = useState(false);
 const [inputText, setInputText] = useState("");
 const isListening = avatarState === "listening";

 const cycleState = () => {
 const states: AvatarState[] = ["idle", "listening", "thinking", "speaking"];
 const currentIndex = states.indexOf(avatarState);
 const nextIndex = (currentIndex + 1) % states.length;
 setAvatarState(states[nextIndex] as AvatarState);
 };

 const handleSend = () => {
 if (!inputText.trim()) return;
 const userMsg = {
 id: `c${transcript.length + 1}`,
 role: "user" as const,
 content: inputText,
 timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
 };
 setTranscript([...transcript, userMsg]);
 setInputText("");

 setTimeout(() => {
 const assistantMsg = {
 id: `c${transcript.length + 2}`,
 role: "assistant" as const,
 content: "I understand. Let me help you with that right away.",
 timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
 };
 setTranscript((prev) => [...prev, assistantMsg]);
 }, 1500);
 };

 const state = stateConfig[avatarState];

 return (
 <div style={{display: 'flex', flexDirection: 'column'}}>
 {/* Avatar */}
 <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
 <motion.div
 animate={avatarState === "listening" ? { scale: [1, 1.05, 1] } : {}}
 transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
 style={{width: '160px', height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
 >
 {/* State ring */}
 <div
 className={`absolute inset-0 rounded-full border-2 ${state.ringColor} ${avatarState === "listening" ? "animate-pulse" : ""}`}
 />
 <div style={{borderRadius: '50%'}} />
 <div style={{width: '96px', height: '96px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
 <span style={{fontWeight: 'bold'}}>N</span>
 </div>
 </motion.div>

 {/* State label */}
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <span style={{position: 'relative', display: 'flex', height: '10px', width: '10px'}}>
 {avatarState !== "idle" && (
 <span style={{position: 'absolute', top: '0', left: '0', height: '100%', width: '100%', borderRadius: '50%', backgroundColor: state.dotColor.replace("bg-", "") }} />
 )}
 <span style={{position: 'relative', display: 'inline-flex', borderRadius: '50%', height: '10px', width: '10px', backgroundColor: state.dotColor.replace("bg-", "") }} />
 </span>
 <span style={{fontSize: '14px', fontWeight: '500', color: '#94a3b8'}}>{state.label}</span>
 </div>
 </div>

 {/* Transcript */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <AnimatePresence>
 {transcript.map((msg) => (
 <motion.div
 key={msg.id}
 initial={{ opacity: 0, y: 8 }}
 animate={{ opacity: 1, y: 0 }}
 className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
 >
 <GlassPanel>
 <p style={{fontSize: '12px', color: '#94a3b8', fontWeight: '500'}}>
 {msg.role === "user" ? "You" : "NOVA"}
 </p>
 <p style={{fontSize: '14px', color: '#f8fafc'}}>{msg.content}</p>
 </GlassPanel>
 </motion.div>
 ))}
 </AnimatePresence>
 </div>

 {/* Controls */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 {/* Main voice button */}
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px'}}>
 <Button
 variant="ghost"
 size="md"
 onClick={() => setMuted(!muted)}
 aria-label={muted ? "Unmute" : "Mute"}
 >
 {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
 </Button>

 <motion.button
 whileTap={{ scale: 0.92 }}
 onClick={cycleState}
 className={`
 w-16 h-16 rounded-full flex items-center justify-center cursor-pointer
 transition-all duration-200 border-2
 ${isListening
 ? "bg-nova-accent/20 border-nova-accent animate-pulse"
 : "bg-nova-primary/20 border-nova-primary"
 }
 `}
 aria-label={isListening ? "Stop listening" : "Start listening"}
 >
 {isListening ? (
 <MicOff size={24} style={{color: '#22d3ee'}} />
 ) : (
 <Mic size={24} style={{color: '#6366f1'}} />
 )}
 </motion.button>

 <Button
 variant="ghost"
 size="md"
 onClick={() => {}}
 aria-label="Stop conversation"
 >
 <StopCircle size={20} />
 </Button>
 </div>

 {/* Quick actions */}
 <div style={{display: 'flex', gap: '8px'}}>
 {quickActions.map((action) => {
 const Icon = action.icon;
 return (
 <button
 key={action.label}
 style={{display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '8px', paddingBottom: '8px', borderRadius: '12px', color: '#94a3b8'}}
 >
 <Icon size={16} />
 <span>{action.label}</span>
 </button>
 );
 })}
 </div>

 {/* Text input */}
 <div style={{display: 'flex', gap: '8px'}}>
 <input
 type="text"
 value={inputText}
 onChange={(e) => setInputText(e.target.value)}
 onKeyDown={(e) => e.key === "Enter" && handleSend()}
 placeholder="Type a message..."
 style={{borderRadius: '12px', paddingLeft: '16px', paddingRight: '16px', fontSize: '14px', color: '#f8fafc'}}
 />
 <Button
 variant="primary"
 size="md"
 onClick={handleSend}
 disabled={!inputText.trim()}
 aria-label="Send message"
 >
 <Send size={18} />
 </Button>
 </div>
 </div>
 </div>
 );
}
