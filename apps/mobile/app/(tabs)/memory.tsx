/**
 * Memory screen — browse, search, and manage memories.
 * Section 5.10 of blueprint.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar, ScrollView } from 'react-native';
import { useTheme } from '../../src/lib/nova-ui';
import { Button, FilterBar, SectionHeader, EmptyState, Card, Badge, Toggle } from '../../src/components/ui';
import { useMemories } from '../../src/store/memory/useMemories';
import type { MemoryCategory, MemoryVisibility, MemoryStatus } from '../../src/lib/nova-ui';

export default function MemoryScreen(): React.JSX.Element {
	const { theme } = useTheme();
	const {
		memories,
		stats,
		searchQuery,
		categoryFilter,
		visibilityFilter,
		statusFilter,
		CATEGORY_ICONS,
		SENSITIVITY_COLORS,
		setSearchQuery,
		setCategoryFilter,
		setVisibilityFilter,
		setStatusFilter,
		updateMemoryStatus,
		deleteMemory,
	} = useMemories();

	const [showAddMemory, setShowAddMemory] = useState(false);
	const [newMemoryContent, setNewMemoryContent] = useState('');
	const [newMemoryCategory, setNewMemoryCategory] = useState<MemoryCategory>('fact');

	const CATEGORY_FILTERS = [
		{ label: 'All', value: 'all' },
		{ label: 'Facts', value: 'fact' },
		{ label: 'Preferences', value: 'preference' },
		{ label: 'Events', value: 'event' },
		{ label: 'Contacts', value: 'contact' },
		{ label: 'Decisions', value: 'decision' },
	];

	const VISIBILITY_FILTERS = [
		{ label: 'All', value: 'all' },
		{ label: 'Private', value: 'private' },
		{ label: 'Shared', value: 'shared' },
		{ label: 'Team', value: 'team' },
	];

	const STATUS_FILTERS = [
		{ label: 'All', value: 'all' },
		{ label: 'Approved', value: 'approved' },
		{ label: 'Proposed', value: 'proposed' },
	];

	const formatDate = (dateStr: string) => {
		const date = new Date(dateStr);
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	};

	const handleAddMemory = () => {
		if (!newMemoryContent.trim()) return;
		useMemories().addMemory({
			userId: 'user-1',
			tenantId: null,
			visibility: 'private',
			category: newMemoryCategory,
			content: newMemoryContent.trim(),
			normalizedFacts: {},
			sourceType: 'manual',
			sourceIds: [],
			confidence: 1.0,
			importance: 0.5,
			sensitivity: 'normal',
			status: 'proposed',
			expiresAt: null,
			embeddingId: null,
		});
		setNewMemoryContent('');
		setShowAddMemory(false);
	};

	const handleApprove = (id: string) => {
		updateMemoryStatus(id, 'approved');
	};

	const handleReject = (id: string) => {
		updateMemoryStatus(id, 'rejected');
	};

	const handleDelete = (id: string) => {
		deleteMemory(id);
	};

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
			<StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
			<ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
				{/* Header */}
				<View style={styles.header}>
					<View>
						<Text style={[styles.headerTitle, { color: theme.colors.text }]}>Memories</Text>
						<Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
							{stats.total} memories · {stats.proposed} pending review
						</Text>
					</View>
					<TouchableOpacity onPress={() => setShowAddMemory(true)}>
						<Text style={[styles.addButton, { color: theme.colors.primary }]}>+ Add</Text>
					</TouchableOpacity>
				</View>

				{/* Stats */}
				<View style={styles.statsRow}>
					<Card style={styles.statCard}>
						<Text style={[styles.statValue, { color: theme.colors.primary }]}>{stats.total}</Text>
						<Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Total</Text>
					</Card>
					<Card style={styles.statCard}>
						<Text style={[styles.statValue, { color: theme.colors.success }]}>{stats.approved}</Text>
						<Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Approved</Text>
					</Card>
					<Card style={styles.statCard}>
						<Text style={[styles.statValue, { color: theme.colors.warning }]}>{stats.proposed}</Text>
						<Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Pending</Text>
					</Card>
				</View>

				{/* Add Memory Form */}
				{showAddMemory && (
					<Card style={styles.addCard}>
						<Text style={[styles.addTitle, { color: theme.colors.text }]}>Add Memory</Text>
						<TextInput
							style={[styles.addInput, { backgroundColor: theme.colors.background, color: theme.colors.text, borderColor: theme.colors.border }]}
							placeholder="What would you like to remember?"
							placeholderTextColor="#64748B"
							value={newMemoryContent}
							onChangeText={setNewMemoryContent}
							multiline
							autoFocus
						/>
						<View style={styles.addActions}>
							<Button title="Save" onPress={handleAddMemory} size="sm" />
							<TouchableOpacity onPress={() => setShowAddMemory(false)}>
								<Text style={[styles.cancelButton, { color: theme.colors.textSecondary }]}>Cancel</Text>
							</TouchableOpacity>
						</View>
					</Card>
				)}

				{/* Search */}
				<TextInput
					style={[styles.searchInput, { backgroundColor: theme.colors.surface, color: theme.colors.text, borderColor: theme.colors.border }]}
					placeholder="Search memories..."
					placeholderTextColor="#64748B"
					value={searchQuery}
					onChangeText={setSearchQuery}
				/>

				{/* Filters */}
				<Text style={[styles.filterLabel, { color: theme.colors.text }]}>Category</Text>
				<FilterBar options={CATEGORY_FILTERS} active={categoryFilter} onChange={(v) => setCategoryFilter(v as MemoryCategory | 'all')} />

				<View style={styles.filterRow}>
					<View style={{ flex: 1 }}>
						<Text style={[styles.filterLabel, { color: theme.colors.text }]}>Visibility</Text>
						<FilterBar options={VISIBILITY_FILTERS} active={visibilityFilter} onChange={(v) => setVisibilityFilter(v as MemoryVisibility | 'all')} />
					</View>
					<View style={{ flex: 1 }}>
						<Text style={[styles.filterLabel, { color: theme.colors.text }]}>Status</Text>
						<FilterBar options={STATUS_FILTERS} active={statusFilter} onChange={(v) => setStatusFilter(v as MemoryStatus | 'all')} />
					</View>
				</View>

				{/* Memory List */}
				{memories.length === 0 ? (
					<EmptyState
						icon="🧠"
						title="No memories found"
						message="Add a memory or adjust your filters."
						action={categoryFilter !== 'all' ? undefined : { label: 'Add Memory', onPress: () => setShowAddMemory(true) }}
					/>
				) : (
					<View style={styles.memoryList}>
						{memories.map((memory) => (
							<Card key={memory.id} style={styles.memoryCard}>
								<View style={styles.memoryHeader}>
									<Text style={styles.memoryIcon}>{CATEGORY_ICONS[memory.category]}</Text>
									<View style={styles.memoryHeaderRight}>
										<View style={styles.memoryBadges}>
											<Badge label={memory.status} color={memory.status === 'approved' ? theme.colors.success : theme.colors.warning} />
											<Badge label={memory.visibility} color={theme.colors.accent} />
										</View>
										<View style={[styles.sensitivityDot, { backgroundColor: SENSITIVITY_COLORS[memory.sensitivity] }]} />
									</View>
								</View>
								<Text style={[styles.memoryContent, { color: theme.colors.text }]}>{memory.content}</Text>
								<Text style={[styles.memoryMeta, { color: theme.colors.textSecondary }]}>
									{formatDate(memory.createdAt)} · {Math.round(memory.confidence * 100)}% confidence
								</Text>
								<View style={[styles.memoryActions, { borderTopColor: theme.colors.border }]}>
									{memory.status === 'proposed' && (
										<>
											<Button title="Approve" variant="primary" size="sm" onPress={() => handleApprove(memory.id)} style={{ flex: 1 }} />
											<Button title="Reject" variant="secondary" size="sm" onPress={() => handleReject(memory.id)} style={{ flex: 1 }} />
										</>
									)}
									{(memory.status === 'approved' || memory.status === 'rejected') && (
										<Button title="Delete" variant="secondary" size="sm" onPress={() => handleDelete(memory.id)} />
									)}
								</View>
							</Card>
						))}
					</View>
				)}
			</ScrollView>
		</View>
	);
}

const TextInput = require('react-native').TextInput;

const styles = StyleSheet.create({
	container: { flex: 1 },
	scrollContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 16 },
	header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
	headerTitle: { fontSize: 28, fontWeight: '700' },
	headerSubtitle: { fontSize: 14, marginTop: 4 },
	addButton: { fontSize: 16, fontWeight: '600', paddingVertical: 8, paddingHorizontal: 12 },
	statsRow: { flexDirection: 'row', gap: 12 },
	statCard: { flex: 1, alignItems: 'center', paddingVertical: 16 },
	statValue: { fontSize: 28, fontWeight: '700' },
	statLabel: { fontSize: 12, marginTop: 4, fontWeight: '500' },
	addCard: { gap: 10 },
	addTitle: { fontSize: 16, fontWeight: '600' },
	addInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
	addActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
	cancelButton: { fontSize: 14, fontWeight: '500' },
	searchInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 },
	filterLabel: { fontSize: 13, fontWeight: '600', marginTop: 8 },
	filterRow: { flexDirection: 'row', gap: 12 },
	memoryList: { gap: 10 },
	memoryCard: { gap: 10, padding: 14 },
	memoryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
	memoryIcon: { fontSize: 24 },
	memoryHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	memoryBadges: { flexDirection: 'row', gap: 4 },
	memoryContent: { fontSize: 15, lineHeight: 22 },
	memoryMeta: { fontSize: 12, marginTop: 4 },
	sensitivityDot: { width: 8, height: 8, borderRadius: 4 },
	memoryActions: { flexDirection: 'row', gap: 10, paddingTop: 12, borderTopWidth: 1 },
});
