"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Mic, Globe, Palette, Bell, Shield, Volume2, Zap } from "lucide-react";
import { GlassPanel } from "../../../components/ui/GlassPanel";
import { Badge } from "../../../components/ui/Badge";

interface ToggleProps {
 label: string;
 description?: string;
 enabled: boolean;
 onToggle: () => void;
}

function Toggle({ label, description, enabled, onToggle }: ToggleProps) {
 return (
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '8px', paddingBottom: '8px'}}>
 <div>
 <p style={{fontSize: '14px', fontWeight: '500', color: '#f8fafc'}}>{label}</p>
 {description && (
 <p style={{fontSize: '12px', color: '#64748b'}}>{description}</p>
 )}
 </div>
 <button
 onClick={onToggle}
 className={`
 relative w-11 h-6 rounded-full cursor-pointer transition-colors duration-200
 ${enabled ? "bg-nova-primary" : "bg-nova-surface-alt"}
 `}
 role="switch"
 aria-checked={enabled}
 aria-label={label}
 >
 <motion.span
 animate={{ x: enabled ? 20 : 2 }}
 transition={{ type: "spring", stiffness: 500, damping: 30 }}
 style={{width: '16px', height: '16px', borderRadius: '50%'}}
 />
 </button>
 </div>
 );
}

const voiceOptions = ["Sarvam Female (Tamil)", "Sarvam Male (Tamil)", "ElevenLabs (English)", "Auto"];

const personalityOptions = [
 { value: "friendly", label: "Friendly", desc: "Warm and conversational" },
 { value: "professional", label: "Professional", desc: "Formal and precise" },
 { value: "executive", label: "Executive", desc: "Concise and directive" },
 { value: "companion", label: "Companion", desc: "Supportive and personal" },
];

export default function SettingsScreen() {
 const [companionName, setCompanionName] = useState("NOVA");
 const [personality, setPersonality] = useState("friendly");
 const [voice, setVoice] = useState(voiceOptions[0]);
 const [language, setLanguage] = useState("Auto (Tamil + English)");
 const [notificationsEnabled, setNotificationsEnabled] = useState(true);
 const [voiceOutputEnabled, setVoiceOutputEnabled] = useState(true);
 const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
 const [memoryEnabled, setMemoryEnabled] = useState(true);

 return (
 <div>
 {/* Profile header */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', display: 'flex', alignItems: 'center', gap: '16px'}}>
 <div>
 <div style={{width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
 <span style={{fontSize: '24px', fontWeight: 'bold'}}>N</span>
 </div>
 <span style={{width: '16px', height: '16px', background: '#10b981', borderRadius: '50%'}} />
 </div>
 <div>
 <h1 style={{fontWeight: 'bold', color: '#f8fafc'}}>{companionName}</h1>
 <p style={{fontSize: '14px', color: '#94a3b8'}}>@abishek</p>
 <Badge variant="primary" size="sm" dot>
 Pro
 </Badge>
 </div>
 </div>

 {/* Companion Config */}
 <div style={{paddingLeft: '16px', paddingRight: '16px'}}>
 <h2 style={{fontSize: '14px', fontWeight: '600', color: '#94a3b8'}}>
 Companion Settings
 </h2>

 <GlassPanel padding="md">
 {/* Name */}
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '8px', paddingBottom: '8px'}}>
 <label style={{fontSize: '14px', fontWeight: '500', color: '#f8fafc'}} htmlFor="companion-name">
 Name
 </label>
 <input
 id="companion-name"
 type="text"
 value={companionName}
 onChange={(e) => setCompanionName(e.target.value)}
 style={{borderRadius: '8px', fontSize: '14px', color: '#f8fafc', width: '192px'}}
 />
 </div>

 {/* Personality */}
 <div style={{paddingTop: '8px', paddingBottom: '8px'}}>
 <p style={{fontSize: '14px', fontWeight: '500', color: '#f8fafc', marginBottom: '8px'}}>Personality</p>
 <div style={{gap: '8px'}}>
 {personalityOptions.map((opt) => (
 <button
 key={opt.value}
 onClick={() => setPersonality(opt.value)}
 className={`
 px-3 py-2 rounded-xl text-left text-xs transition-all duration-200 cursor-pointer
 border
 ${personality === opt.value
 ? "bg-nova-primary/15 border-nova-primary/30 text-nova-primary"
 : "bg-nova-surface/40 border-transparent text-nova-text-muted hover:text-nova-text"
 }
 `}
 >
 <p style={{fontWeight: '500'}}>{opt.label}</p>
 <p>{opt.desc}</p>
 </button>
 ))}
 </div>
 </div>
 </GlassPanel>

 {/* Voice & Language */}
 <GlassPanel padding="md">
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <Volume2 size={16} style={{color: '#6366f1'}} />
 <h3 style={{fontSize: '14px', fontWeight: '600', color: '#f8fafc'}}>Voice & Language</h3>
 </div>

 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '8px', paddingBottom: '8px'}}>
 <p style={{fontSize: '14px', color: '#94a3b8'}}>Voice</p>
 <select
 value={voice}
 onChange={(e) => setVoice(e.target.value)}
 style={{borderRadius: '8px', fontSize: '14px', color: '#f8fafc'}}
 >
 {voiceOptions.map((v) => (
 <option key={v} value={v}>{v}</option>
 ))}
 </select>
 </div>

 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '8px', paddingBottom: '8px'}}>
 <p style={{fontSize: '14px', color: '#94a3b8'}}>Language</p>
 <select
 value={language}
 onChange={(e) => setLanguage(e.target.value)}
 style={{borderRadius: '8px', fontSize: '14px', color: '#f8fafc'}}
 >
 <option>Auto (Tamil + English)</option>
 <option>English only</option>
 <option>Tamil only</option>
 <option>Tamil + English</option>
 </select>
 </div>
 </GlassPanel>

 {/* Features */}
 <GlassPanel padding="md">
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <Zap size={16} style={{color: '#22d3ee'}} />
 <h3 style={{fontSize: '14px', fontWeight: '600', color: '#f8fafc'}}>Features</h3>
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
 description="Say 'Hey Nova' to activate"
 enabled={wakeWordEnabled}
 onToggle={() => setWakeWordEnabled(!wakeWordEnabled)}
 />
 <Toggle
 label="Memory"
 description="Save approved facts for future conversations"
 enabled={memoryEnabled}
 onToggle={() => setMemoryEnabled(!memoryEnabled)}
 />
 </GlassPanel>

 {/* Avatar Customization placeholder */}
 <GlassPanel padding="md">
 <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
 <Palette size={16} style={{color: '#8b5cf6'}} />
 <h3 style={{fontSize: '14px', fontWeight: '600', color: '#f8fafc'}}>Avatar</h3>
 </div>
 <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
 <div style={{width: '56px', height: '56px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
 <span style={{fontWeight: 'bold'}}>N</span>
 </div>
 <div>
 <p style={{fontSize: '14px', color: '#f8fafc'}}>Default Avatar</p>
 <p style={{fontSize: '12px', color: '#64748b'}}>Classic · Breathing idle</p>
 </div>
 </div>
 </GlassPanel>
 </div>

 {/* Spacer */}
 <div style={{height: '16px'}} />
 </div>
 );
}
