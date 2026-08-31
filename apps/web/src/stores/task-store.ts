'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Task {
 id: string;
 title: string;
 completed: boolean;
 priority: 'low' | 'medium' | 'high';
 dueDate?: Date;
 category: string;
 createdAt: Date;
 completedAt?: Date;
 tags?: string[];
}

export interface Reminder {
 id: string;
 title: string;
 datetime: Date;
 recurring?: 'daily' | 'weekly' | 'monthly';
 recurringPattern?: string;
 isActive: boolean;
 sound?: string;
}

interface TaskStore {
 tasks: Task[];
 reminders: Reminder[];
 filter: 'all' | 'active' | 'completed';
 addTask: (task: Omit<Task, 'id' | 'createdAt'>) => Task;
 toggleTask: (id: string) => void;
 deleteTask: (id: string) => void;
 setFilter: (filter: TaskStore['filter']) => void;
 addReminder: (reminder: Omit<Reminder, 'id'>) => Reminder;
 deleteReminder: (id: string) => void;
 toggleReminder: (id: string) => void;
 getFilteredTasks: () => Task[];
}

export const useTaskStore = create<TaskStore>()(
 persist(
 (set, get) => ({
 tasks: [],
 reminders: [],
 filter: 'all',

 addTask: (taskData) => {
 const task: Task = {
 ...taskData,
 id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
 createdAt: new Date(),
 };
 set((state) => ({
 tasks: [...state.tasks, task],
 }));
 return task;
 },

 toggleTask: (id) =>
 set((state) => ({
 tasks: state.tasks.map((t) =>
 t.id === id
 ? {
 ...t,
 completed: !t.completed,
 completedAt: !t.completed ? new Date() : undefined,
 }
 : t
 ),
 })),

 deleteTask: (id) =>
 set((state) => ({
 tasks: state.tasks.filter((t) => t.id !== id),
 })),

 setFilter: (filter) => set({ filter }),

 addReminder: (reminderData) => {
 const reminder: Reminder = {
 ...reminderData,
 id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
 };
 set((state) => ({
 reminders: [...state.reminders, reminder],
 }));
 return reminder;
 },

 deleteReminder: (id) =>
 set((state) => ({
 reminders: state.reminders.filter((r) => r.id !== id),
 })),

 toggleReminder: (id) =>
 set((state) => ({
 reminders: state.reminders.map((r) =>
 r.id === id ? { ...r, isActive: !r.isActive } : r
 ),
 })),

 getFilteredTasks: () => {
 const { tasks, filter } = get();
 switch (filter) {
 case 'active': return tasks.filter((t) => !t.completed);
 case 'completed': return tasks.filter((t) => t.completed);
 default: return tasks;
 }
 },
 }),
 {
 name: 'task-storage',
 }
 )
);
