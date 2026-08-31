'use client';

import { motion } from 'framer-motion';
import { MessageSquare, Search, Mic, Play, Clock, Trash2, Download } from 'lucide-react';
import { useState } from 'react';
import { COLORS, ANIMATION_DURATION } from '../../lib/design-tokens';

interface Conversation {
 id: string;
 title: string;
 preview: string;
 timestamp: Date;
 duration: string;
 messages: number;
 tags: string[];
}

const mockConversations: Conversation[] = [
 {
 id: '1',
 title: 'Q4 Planning Discussion',
 preview: 'Let me help you plan the Q4 launch timeline...',
 timestamp: new Date(Date.now() - 3600000),
 duration: '4:32',
 messages: 12,
 tags: ['planning', 'Q4'],
 },
 {
 id: '2',
 title: 'Daily Standup Notes',
 preview: 'Key points from today: API integration complete...',
 timestamp: new Date(Date.now() - 86400000),
 duration: '2:15',
 messages: 8,
 tags: ['standup', 'daily'],
 },
];

export default function ConversationsScreen() {
 const [conversations] = useState<Conversation[]>(mockConversations);
 const [selectedId, setSelectedId] = useState<string | null>(null);

 const formatTimestamp = (date: Date) => {
 const now = new Date();
 const diff = now.getTime() - date.getTime();
 const hours = Math.floor(diff / 3600000);
 if (hours < 1) return 'Just now';
 if (hours < 24) return `${hours}h ago`;
 return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
 };

 return (
 <div className="min-h-screen bg-nova-bg p-6">
 <div className="max-w-4xl mx-auto">
 {/* Header */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
 <div>
 <h1 style={{fontSize: '24px', fontWeight: 'bold', color: '#f8fafc'}}>
 Conversations
 </h1>
 <p style={{fontSize: '14px', color: '#94a3b8'}}>
 Your chat history with NOVA
 </p>
 </div>
 <button
 style={{width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1'}}
 aria-label="New conversation"
 >
 <MessageSquare size={18} />
 </button>
 </div>

 {/* Search */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', marginTop: '20px'}}>
 <div style={{position: 'relative'}}>
 <Search size={16} style={{position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b'}} />
 <input
 type="text"
 placeholder="Search conversations..."
 style={{
 width: '100%',
 borderRadius: '12px',
 paddingLeft: '36px',
 paddingRight: '16px',
 paddingTop: '10px',
 paddingBottom: '10px',
 fontSize: '14px',
 background: '#111827',
 border: '1px solid #1e293b',
 color: '#f8fafc',
 outline: 'none',
 }}
 />
 </div>
 </div>

 {/* Voice input */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', marginTop: '16px'}}>
 <button
 style={{
 width: '100%',
 paddingTop: '14px',
 paddingBottom: '14px',
 borderRadius: '12px',
 background: 'linear-gradient(135deg, #6366f1 0%, #22d3ee 100%)',
 color: 'white',
 border: 'none',
 fontWeight: '600',
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 gap: '8px',
 cursor: 'pointer',
 }}
 >
 <Mic size={18} />
 Start Voice Conversation
 </button>
 </div>

 {/* Conversations List */}
 <div style={{paddingLeft: '16px', paddingRight: '16px', marginTop: '24px'}}>
 <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
 {conversations.map((conv, index) => (
 <motion.div
 key={conv.id}
 initial={{ opacity: 0, y: 20 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ delay: index * 0.05 }}
 onClick={() => setSelectedId(conv.id)}
 className="cursor-pointer"
 style={{
 padding: '16px',
 borderRadius: '16px',
 background: '#111827',
 border: selectedId === conv.id ? '2px solid #6366f1' : '1px solid #1e293b',
 transition: 'all 0.2s',
 }}
 >
 <div style={{display: 'flex', alignItems: 'start', gap: '12px'}}>
 <div
 style={{
 width: '48px',
 height: '48px',
 borderRadius: '12px',
 background: 'linear-gradient(135deg, #6366f1 0%, #22d3ee 100%)',
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 flexShrink: 0,
 }}
 >
 <MessageSquare size={24} color="white" />
 </div>
 <div style={{flex: 1, minWidth: 0}}>
 <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px'}}>
 <h3 style={{fontSize: '16px', fontWeight: '600', color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
 {conv.title}
 </h3>
 <span style={{fontSize: '12px', color: '#64748b', flexShrink: 0, marginLeft: '8px'}}>
 {formatTimestamp(conv.timestamp)}
 </span>
 </div>
 <p style={{fontSize: '14px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
 {conv.preview}
 </p>
 <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px'}}>
 <span style={{fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px'}}>
 <Clock size={12} />
 {conv.duration}
 </span>
 <span style={{fontSize: '12px', color: '#64748b'}}>
 {conv.messages} messages
 </span>
 <div style={{display: 'flex', gap: '4px'}}>
 {conv.tags.map(tag => (
 <span
 key={tag}
 style={{
 padding: '2px 8px',
 borderRadius: '6px',
 background: '#1e293b',
 color: '#6366f1',
 fontSize: '11px',
 fontWeight: '500',
 }}
 >
 #{tag}
 </span>
 ))}
 </div>
 </div>
 </div>
 <div style={{display: 'flex', gap: '4px'}}>
 <button
 style={{padding: '4px', borderRadius: '8px', color: '#64748b'}}
 aria-label="Play"
 >
 <Play size={16} />
 </button>
 <button
 style={{padding: '4px', borderRadius: '8px', color: '#64748b'}}
 aria-label="Download"
 >
 <Download size={16} />
 </button>
 <button
 style={{padding: '4px', borderRadius: '8px', color: '#ef4444'}}
 aria-label="Delete"
 >
 <Trash2 size={16} />
 </button>
 </div>
 </div>
 </motion.div>
 ))}
 </div>
 </div>

 {/* Empty state when no conversations */}
 {conversations.length === 0 && (
 <div style={{textAlign: 'center', padding: '48px 16px', color: '#64748b'}}>
 <MessageSquare size={48} style={{margin: '0 auto 16px', opacity: 0.5}} />
 <p style={{fontSize: '16px', fontWeight: '500'}}>No conversations yet</p>
 <p style={{fontSize: '14px', marginTop: '4px'}}>
 Start a voice conversation or type a message to begin
 </p>
 </div>
 )}
 </div>
 </div>
 );
}
