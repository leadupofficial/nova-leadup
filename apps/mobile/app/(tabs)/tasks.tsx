/**
 * NOVA — Tasks Screen
 * Section 5.8 of blueprint.
 *
 * Sections: Today / Upcoming / Overdue / Completed.
 * Each task: title, due time, status, source, tags, quick actions.
 */

import { useState, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, StatusBar, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/lib/nova-ui';
import { Button, SectionHeader, FilterBar, EmptyState, Card, Badge } from '../../src/components/ui';
import { mockTasks } from '../../src/mock/data';
import type { Task, TaskStatus } from '../../src/lib/nova-ui';

type TaskFilter = 'all' | 'pending' | 'in_progress' | 'completed' | 'overdue';

export default function TasksScreen(): React.JSX.Element {
	const { theme } = useTheme();
	const router = useRouter();
	const [tasks, setTasks] = useState<Task[]>(mockTasks);
	const [filter, setFilter] = useState<TaskFilter>('all');

	const now = new Date();

	const filteredTasks = useMemo(() => {
		switch (filter) {
			case 'pending': return tasks.filter((t) => t.status === 'pending');
			case 'in_progress': return tasks.filter((t) => t.status === 'in_progress');
			case 'completed': return tasks.filter((t) => t.status === 'completed');
			case 'overdue': return tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now && t.status !== 'completed');
			default: return tasks;
		}
	}, [tasks, filter]);

	const taskCounts = useMemo(() => ({
		all: tasks.length,
		pending: tasks.filter((t) => t.status === 'pending').length,
		in_progress: tasks.filter((t) => t.status === 'in_progress').length,
		completed: tasks.filter((t) => t.status === 'completed').length,
		overdue: tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now && t.status !== 'completed').length,
	}), [tasks]);

	const isOverdue = (task: Task) => task.dueAt && new Date(task.dueAt) < now && task.status !== 'completed';

	const formatDue = (dueAt: string) => {
		const date = new Date(dueAt);
		const nowDate = new Date();
		const isToday = date.toDateString() === nowDate.toDateString();
		const tomorrow = new Date(nowDate); tomorrow.setDate(tomorrow.getDate() + 1);
		const isTomorrow = date.toDateString() === tomorrow.toDateString();

		const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
		if (isToday) return `Today, ${time}`;
		if (isTomorrow) return `Tomorrow, ${time}`;
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + `, ${time}`;
	};

	const toggleComplete = (task: Task) => {
		const newStatus: TaskStatus = task.status === 'completed' ? 'pending' : 'completed';
		setTasks((prev) =>
			prev.map((t) =>
				t.id === task.id
					? { ...t, status: newStatus, completedAt: newStatus === 'completed' ? new Date().toISOString() : null, updatedAt: new Date().toISOString() }
					: t
			)
		);
	};

	const deleteTask = (task: Task) => {
		Alert.alert('Delete task', `Are you sure you want to delete "${task.title}"?`, [
			{ text: 'Cancel', style: 'cancel' },
			{ text: 'Delete', style: 'destructive', onPress: () => setTasks((prev) => prev.filter((t) => t.id !== task.id)) },
		]);
	};

	const statusColor: Record<TaskStatus, string> = {
		pending: theme.colors.warning,
		in_progress: theme.colors.accent,
		completed: theme.colors.success,
		cancelled: theme.colors.danger,
	};

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
			<StatusBar barStyle="light-content" />

			<ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
				<SectionHeader
					title="Tasks"
					subtitle={`${tasks.filter((t) => t.status !== 'completed').length} pending`}
					action={{ label: '+ New', onPress: () => Alert.alert('New task', 'Create a new task (coming soon).') }}
				/>

				<FilterBar
					options={[
						{ label: `All (${taskCounts.all})`, value: 'all' },
						{ label: `Pending (${taskCounts.pending})`, value: 'pending' },
						{ label: `In Progress (${taskCounts.in_progress})`, value: 'in_progress' },
						{ label: `Overdue (${taskCounts.overdue})`, value: 'overdue' },
						{ label: `Done (${taskCounts.completed})`, value: 'completed' },
					]}
					active={filter}
					onChange={(v) => setFilter(v as TaskFilter)}
				/>

				{filteredTasks.length === 0 ? (
					<EmptyState
						icon="✅"
						title="No tasks"
						message={filter === 'completed' ? 'You haven\'t completed any tasks yet.' : filter === 'overdue' ? 'Great! No overdue tasks.' : 'All clear! Add a new task to get started.'}
						action={filter === 'all' || filter === 'pending' ? { label: 'New Task', onPress: () => Alert.alert('New task', 'Coming soon!') } : undefined}
					/>
				) : (
					<View style={styles.taskList}>
						{filteredTasks.map((task) => (
							<Card key={task.id} style={[styles.taskCard, task.status === 'completed' && styles.taskCardCompleted]}>
								<View style={styles.taskHeader}>
									<TouchableOpacity
										onPress={() => toggleComplete(task)}
										style={[styles.checkbox, { borderColor: task.status === 'completed' ? theme.colors.success : theme.colors.border }]}
										accessibilityLabel={task.status === 'completed' ? 'Mark incomplete' : 'Mark complete'}
									>
										{task.status === 'completed' && <Text style={[styles.checkmark, { color: theme.colors.success }]}>✓</Text>}
									</TouchableOpacity>
									<View style={styles.taskInfo}>
										<Text style={[styles.taskTitle, { color: task.status === 'completed' ? theme.colors.textSecondary : theme.colors.text }]}>
											{task.title}
										</Text>
										<View style={styles.taskMeta}>
											{task.dueAt && (
												<Text style={[styles.taskDue, { color: isOverdue(task) ? theme.colors.danger : theme.colors.textSecondary }]}>
													{isOverdue(task) ? '⚠ ' : ''}{formatDue(task.dueAt)}
												</Text>
											)}
											{task.source === 'ai' && task.aiConfidence && (
												<Badge label={`AI ${Math.round(task.aiConfidence * 100)}%`} color={theme.colors.accent} />
											)}
											<Badge label={task.source} color={theme.colors.primary} />
										</View>
										{task.tags.length > 0 && (
											<View style={styles.tagRow}>
												{task.tags.map((tag) => (
													<View key={tag} style={[styles.tag, { backgroundColor: `${theme.colors.primary}15` }]}>
														<Text style={[styles.tagText, { color: theme.colors.primary }]}>{tag}</Text>
													</View>
												))}
											</View>
										)}
									</View>
								</View>
								<View style={[styles.taskActions, { borderTopColor: theme.colors.border }]}>
									<TouchableOpacity onPress={() => router.push(`/tool-confirmation?taskId=${task.id}`)}>
										<Text style={[styles.actionText, { color: theme.colors.accent }]}>Edit</Text>
									</TouchableOpacity>
									<Text style={[styles.actionDivider, { color: theme.colors.border }]}>|</Text>
									<TouchableOpacity onPress={() => deleteTask(task)}>
										<Text style={[styles.actionText, { color: theme.colors.danger }]}>Delete</Text>
									</TouchableOpacity>
								</View>
							</Card>
						))}
					</View>
				)}
			</ScrollView>

			{/* FAB */}
			<TouchableOpacity
				style={[styles.fab, { backgroundColor: theme.colors.primary }]}
				onPress={() => Alert.alert('New Task', 'Create task form coming soon.')}
				accessibilityLabel="Create new task"
			>
				<Text style={styles.fabText}>+</Text>
			</TouchableOpacity>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	scrollContent: { padding: 24, paddingBottom: 80 },
	taskList: { gap: 12, marginTop: 8 },
	taskCard: { borderRadius: 16, padding: 16, borderWidth: 1, gap: 12 },
	taskCardCompleted: { opacity: 0.7 },
	taskHeader: { flexDirection: 'row', gap: 12 },
	checkbox: {
		width: 22,
		height: 22,
		borderRadius: 11,
		borderWidth: 2,
		alignItems: 'center',
		justifyContent: 'center',
		marginTop: 2,
	},
	checkmark: { fontSize: 14, fontWeight: '700' },
	taskInfo: { flex: 1, gap: 6 },
	taskTitle: { fontSize: 16, fontWeight: '500', lineHeight: 22 },
	taskMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
	taskDue: { fontSize: 13 },
	tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
	tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
	tagText: { fontSize: 11, fontWeight: '600' },
	taskActions: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingTop: 12,
		borderTopWidth: 1,
	},
	actionText: { fontSize: 14, fontWeight: '600' },
	actionDivider: { fontSize: 14 },
	fab: {
		position: 'absolute',
		bottom: 24,
		right: 24,
		width: 56,
		height: 56,
		borderRadius: 28,
		alignItems: 'center',
		justifyContent: 'center',
		shadowColor: '#6366F1',
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.4,
		shadowRadius: 12,
		elevation: 8,
	},
	fabText: { color: '#FFFFFF', fontSize: 28, fontWeight: '300' },
});
