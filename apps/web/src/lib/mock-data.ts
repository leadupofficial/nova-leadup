export interface Task {
 id: string;
 title: string;
 dueDate: string;
 dueTime?: string;
 status: "pending" | "completed" | "overdue";
 priority: "high" | "medium" | "low";
 tags: string[];
 source: "voice" | "meeting" | "manual" | "integration";
 section: "today" | "upcoming" | "overdue";
}

export interface Memory {
 id: string;
 category: "person" | "company" | "project" | "preference" | "goal" | "event" | "decision" | "fact" | "task" | "reminder" | "relationship" | "conversation";
 title: string;
 description: string;
 confidence: number;
 importance: number;
 sourceType: "conversation" | "recording" | "manual" | "integration" | "meeting";
 createdAt: string;
 tags?: string[];
}

export interface Reminder {
 id: string;
 title: string;
 dateTime: string;
 channel: string;
 status: "pending" | "dismissed" | "completed";
 linkedTask?: string;
}

export interface ConversationMessage {
 id: string;
 role: "user" | "assistant";
 content: string;
 timestamp: string;
}

export const mockTasks: Task[] = [
 {
 id: "t1",
 title: "Send quotation to Kumar",
 dueDate: "Fri, Aug 29",
 dueTime: "10:00 AM",
 status: "pending",
 priority: "high",
 tags: ["CRM", "Website"],
 source: "meeting",
 section: "today",
 },
 {
 id: "t2",
 title: "Call Ramesh about payment",
 dueDate: "Today",
 dueTime: "5:00 PM",
 status: "pending",
 priority: "high",
 tags: ["Finance"],
 source: "voice",
 section: "today",
 },
 {
 id: "t3",
 title: "Prepare CRM proposal for Kumar",
 dueDate: "Mon, Sep 1",
 status: "pending",
 priority: "medium",
 tags: ["Business"],
 source: "manual",
 section: "upcoming",
 },
 {
 id: "t4",
 title: "Review meeting summary from client call",
 dueDate: "Today",
 status: "pending",
 priority: "medium",
 tags: ["Meeting"],
 source: "voice",
 section: "today",
 },
 {
 id: "t5",
 title: "Follow up on website design mockups",
 dueDate: "Tue, Sep 2",
 status: "pending",
 priority: "low",
 tags: ["Website"],
 source: "meeting",
 section: "upcoming",
 },
 {
 id: "t6",
 title: "Send weekly BNI update",
 dueDate: "Wed, Aug 20",
 status: "overdue",
 priority: "medium",
 tags: ["BNI", "Networking"],
 source: "manual",
 section: "overdue",
 },
 {
 id: "t7",
 title: "Update client database entries",
 dueDate: "Thu, Aug 21",
 status: "overdue",
 priority: "low",
 tags: ["CRM"],
 source: "manual",
 section: "overdue",
 },
];

export const mockMemories: Memory[] = [
 {
 id: "m1",
 category: "person",
 title: "Kumar, CRM client",
 description: "Interested in CRM and website development for his business. Budget: ₹2,00,000.",
 confidence: 0.92,
 importance: 0.95,
 sourceType: "conversation",
 createdAt: "Aug 27, 2026",
 tags: ["client", "lead"],
 },
 {
 id: "m2",
 category: "project",
 title: "Website + CRM Development",
 description: "Kumar's business website and CRM integration project. Proposal pending, deadline next month.",
 confidence: 0.88,
 importance: 0.85,
 sourceType: "recording",
 createdAt: "Aug 27, 2026",
 tags: ["project", "client"],
 },
 {
 id: "m3",
 category: "preference",
 title: "Tamil-English (Tanglish) responses preferred",
 description: "User prefers concise responses in Tamil-English mixed format for business communication.",
 confidence: 0.96,
 importance: 0.6,
 sourceType: "conversation",
 createdAt: "Aug 20, 2026",
 tags: ["language"],
 },
 {
 id: "m4",
 category: "event",
 title: "Team meeting tomorrow at 3 PM",
 description: "Scheduled meeting with 5 attendees. Discussion: Q3 planning and CRM roadmap.",
 confidence: 0.91,
 importance: 0.75,
 sourceType: "meeting",
 createdAt: "Aug 26, 2026",
 tags: ["meeting", "Q3"],
 },
 {
 id: "m5",
 category: "person",
 title: "Ramesh, Finance contact",
 description: "Payment discussion pending. Follow up on outstanding invoice for August.",
 confidence: 0.85,
 importance: 0.7,
 sourceType: "conversation",
 createdAt: "Aug 25, 2026",
 tags: ["finance", "contact"],
 },
 {
 id: "m6",
 category: "decision",
 title: "Tech stack: React Native for mobile app",
 description: "Decided to use React Native for the mobile companion app during Kumar's discussion.",
 confidence: 0.87,
 importance: 0.8,
 sourceType: "meeting",
 createdAt: "Aug 27, 2026",
 tags: ["tech", "architecture"],
 },
];

export const mockReminders: Reminder[] = [
 {
 id: "r1",
 title: "Call Kumar about CRM proposal",
 dateTime: "Tomorrow, 10:00 AM",
 channel: "Push notification",
 status: "pending",
 linkedTask: "t1",
 },
 {
 id: "r2",
 title: "Weekly BNI meeting prep",
 dateTime: "Today, 2:00 PM",
 channel: "Push notification",
 status: "pending",
 },
 {
 id: "r3",
 title: "Send quotation to Kumar",
 dateTime: "Fri, Aug 29, 9:00 AM",
 channel: "Push + Email",
 status: "pending",
 linkedTask: "t1",
 },
];

export const mockConversation: ConversationMessage[] = [
 {
 id: "c1",
 role: "assistant",
 content: "Good morning, Abishek! You have 3 reminders today, next at 10:00 AM. How can I help?",
 timestamp: "9:00 AM",
 },
 {
 id: "c2",
 role: "user",
 content: "Remind me to call Kumar about the CRM proposal tomorrow at 10.",
 timestamp: "9:02 AM",
 },
 {
 id: "c3",
 role: "assistant",
 content: "Done! I have set a reminder for tomorrow at 10:00 AM to call Kumar about the CRM proposal.",
 timestamp: "9:02 AM",
 },
];

export const overviewStats = [
 { label: "Reminders", count: 3, icon: "bell", color: "warning" },
 { label: "Tasks", count: 5, icon: "check-circle", color: "primary" },
 { label: "Recent memories", count: 4, icon: "brain", color: "accent" },
];

export const categoryMeta: Record<string, { emoji: string; label: string; color: string }> = {
 person: { emoji: "👤", label: "Person", color: "text-nova-accent" },
 company: { emoji: "🏢", label: "Company", color: "text-nova-primary" },
 project: { emoji: "📅", label: "Project", color: "text-nova-secondary" },
 preference: { emoji: "⚙️", label: "Preference", color: "text-nova-warning" },
 goal: { emoji: "🎯", label: "Goal", color: "text-nova-success" },
 event: { emoji: "📆", label: "Event", color: "text-nova-accent" },
 decision: { emoji: "✅", label: "Decision", color: "text-nova-success" },
 fact: { emoji: "ℹ️", label: "Fact", color: "text-nova-textMuted" },
 task: { emoji: "📝", label: "Task", color: "text-nova-primary" },
 reminder: { emoji: "🔔", label: "Reminder", color: "text-nova-warning" },
 relationship: { emoji: "👥", label: "Relationship", color: "text-nova-secondary" },
 conversation: { emoji: "💬", label: "Conversation", color: "text-nova-accent" },
};
