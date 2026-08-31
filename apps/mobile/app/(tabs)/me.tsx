/**
 * NOVA — Profile & Settings Screen ("Me")
 * Section 5.16 of blueprint.
 *
 * Profile info, companion selector, language preferences,
 * notifications, legal links, sign-out.
 */

import { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch, Alert, StatusBar } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/lib/nova-ui';
import { Button, SectionHeader, Card, Badge } from '../../src/components/ui';
import { useAuth } from '../../src/store/auth';

const LANGUAGE_OPTIONS = ['Tamil', 'English', 'Hindi', 'Auto-detect'];
const VOICE_OPTIONS = ['Companion voice', 'Kavi (Tamil)', 'Priya (Tamil)', 'Alex (English)'];
const NOTIFICATION_TYPES = [
	{ key: 'tasks', label: 'Tasks', description: 'Task reminders and due dates' },
	{ key: 'meetings', label: 'Meetings', description: 'Meeting reminders and summaries' },
	{ key: 'updates', label: 'Updates', description: 'Companion activity and insights' },
	{ key: 'community', label: 'Community', description: 'Tips and community news' },
];

export default function MeScreen(): React.JSX.Element {
	const { theme } = useTheme();
	const router = useRouter();
	const { user, signOut } = useAuth();

	const [selectedLanguage, setSelectedLanguage] = useState('Auto-detect');
	const [selectedVoice, setSelectedVoice] = useState('Companion voice');
	const [notificationSettings, setNotificationSettings] = useState({
		tasks: true,
		meetings: true,
		updates: true,
		community: false,
	});

	const toggleNotification = (key: keyof typeof notificationSettings) => {
		setNotificationSettings((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	const handleSignOut = () => {
		Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
			{ text: 'Cancel', style: 'cancel' },
			{
				text: 'Sign Out',
				style: 'destructive',
				onPress: () => {
					signOut();
					router.replace('/onboarding');
				},
			},
		]);
	};

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
			<StatusBar barStyle="light-content" />

			<ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
				<SectionHeader title="Profile" subtitle="Manage your account and preferences" />

				{/* Profile card */}
				<Card style={styles.profileCard}>
					<View style={[styles.avatar, { backgroundColor: theme.colors.primary }]}>
						<Text style={styles.avatarText}>{(user?.name?.[0] || 'U').toUpperCase()}</Text>
					</View>
					<Text style={[styles.profileName, { color: theme.colors.text }]}>
						{user?.name || 'User'}
					</Text>
					<Text style={[styles.profileEmail, { color: theme.colors.textSecondary }]}>
						{user?.email || 'user@example.com'}
					</Text>
					<View style={[styles.editProfileButton, { borderColor: theme.colors.border }]}>
						<Text style={[styles.editProfileText, { color: theme.colors.accent }]}>Edit Profile</Text>
					</View>
				</Card>

				{/* Companion selector */}
				<Card style={styles.card}>
					<Text style={[styles.cardTitle, { color: theme.colors.text }]}>Companion</Text>
					<TouchableOpacity style={[styles.companionRow, { borderColor: theme.colors.border }]}>
						<View style={[styles.companionAvatar, { backgroundColor: theme.colors.primary }]}>
							<Text style={styles.companionInitial}>K</Text>
						</View>
						<View style={styles.companionInfo}>
							<Text style={[styles.companionName, { color: theme.colors.text }]}>Kavi</Text>
							<Text style={[styles.companionDesc, { color: theme.colors.textSecondary }]}>
								Active · Tamil Companion
							</Text>
						</View>
						<Text style={[styles.chevron, { color: theme.colors.textSecondary }]}>›</Text>
					</TouchableOpacity>
				</Card>

				{/* Language preferences */}
				<Card style={styles.card}>
					<Text style={[styles.cardTitle, { color: theme.colors.text }]}>Language</Text>
					<Text style={[styles.cardSubtitle, { color: theme.colors.textSecondary }]}>
						Primary language for transcription and responses.
					</Text>
					<View style={styles.optionList}>
						{LANGUAGE_OPTIONS.map((lang) => (
							<TouchableOpacity
								key={lang}
								onPress={() => setSelectedLanguage(lang)}
								style={[
									styles.optionRow,
									{ borderColor: theme.colors.border },
								]}
							>
								<Text style={[styles.optionLabel, { color: theme.colors.text }]}>{lang}</Text>
								{selectedLanguage === lang && (
									<Text style={[styles.optionCheck, { color: theme.colors.primary }]}>✓</Text>
								)}
							</TouchableOpacity>
						))}
					</View>
				</Card>

				{/* Voice selection */}
				<Card style={styles.card}>
					<Text style={[styles.cardTitle, { color: theme.colors.text }]}>Companion Voice</Text>
					<View style={styles.optionList}>
						{VOICE_OPTIONS.map((voice) => (
							<TouchableOpacity
								key={voice}
								onPress={() => setSelectedVoice(voice)}
								style={[styles.optionRow, { borderColor: theme.colors.border }]}
							>
								<Text style={[styles.optionLabel, { color: theme.colors.text }]}>{voice}</Text>
								{selectedVoice === voice && (
									<Text style={[styles.optionCheck, { color: theme.colors.primary }]}>✓</Text>
								)}
							</TouchableOpacity>
						))}
					</View>
				</Card>

				{/* Notifications */}
				<Card style={styles.card}>
					<Text style={[styles.cardTitle, { color: theme.colors.text }]}>Notifications</Text>
					{NOTIFICATION_TYPES.map((notif) => (
						<View key={notif.key} style={styles.notifRow}>
							<View style={styles.notifInfo}>
								<Text style={[styles.notifLabel, { color: theme.colors.text }]}>
									{notif.label}
								</Text>
								<Text style={[styles.notifDesc, { color: theme.colors.textSecondary }]}>
									{notif.description}
								</Text>
							</View>
							<Switch
								value={notificationSettings[notif.key]}
								onValueChange={() => toggleNotification(notif.key)}
								trackColor={{ false: '#475569', true: theme.colors.primary }}
								thumbColor="#FFFFFF"
							/>
						</View>
					))}
				</Card>

				{/* Legal & support */}
				<Card style={styles.card}>
					<Text style={[styles.cardTitle, { color: theme.colors.text }]}>Legal & Support</Text>
					{[
						{ label: 'Privacy Policy', route: '/privacy' },
						{ label: 'Terms of Service', route: null },
						{ label: 'About NOVA', route: null },
						{ label: 'Help & Support', route: null },
					].map((item) => (
						<TouchableOpacity
							key={item.label}
							onPress={() => item.route && router.push(item.route as any)}
							style={[styles.linkRow, { borderBottomColor: theme.colors.border }]}
						>
							<Text style={[styles.linkLabel, { color: theme.colors.text }]}>{item.label}</Text>
							<Text style={[styles.linkChevron, { color: theme.colors.textSecondary }]}>›</Text>
						</TouchableOpacity>
					))}
				</Card>

				{/* Sign out */}
				<TouchableOpacity onPress={handleSignOut} style={styles.signOutButton}>
					<Text style={[styles.signOutText, { color: theme.colors.danger }]}>Sign Out</Text>
				</TouchableOpacity>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	scrollContent: { padding: 24, paddingBottom: 48 },
	profileCard: {
		alignItems: 'center',
		gap: 12,
		padding: 24,
		borderRadius: 16,
		borderWidth: 1,
		marginBottom: 16,
	},
	avatar: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
	avatarText: { color: '#FFFFFF', fontSize: 28, fontWeight: '700' },
	profileName: { fontSize: 20, fontWeight: '700' },
	profileEmail: { fontSize: 14 },
	editProfileButton: {
		marginTop: 8,
		paddingHorizontal: 20,
		paddingVertical: 8,
		borderRadius: 10,
		borderWidth: 1,
	},
	editProfileText: { fontSize: 14, fontWeight: '600' },
	card: {
		borderRadius: 16,
		padding: 16,
		borderWidth: 1,
		gap: 12,
		marginBottom: 16,
	},
	cardTitle: { fontSize: 17, fontWeight: '700' },
	cardSubtitle: { fontSize: 13, marginTop: 2, lineHeight: 18 },
	companionRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		padding: 12,
		borderRadius: 12,
		borderWidth: 1,
	},
	companionAvatar: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
	},
	companionInitial: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
	companionInfo: { flex: 1 },
	companionName: { fontSize: 15, fontWeight: '600' },
	companionDesc: { fontSize: 13, marginTop: 1 },
	chevron: { fontSize: 22, fontWeight: '300' },
	optionList: { gap: 6, marginTop: 8 },
	optionRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 14,
		borderRadius: 12,
		borderWidth: 1,
	},
	optionLabel: { fontSize: 15 },
	optionCheck: { fontSize: 18, fontWeight: '700' },
	notifRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingVertical: 6,
	},
	notifInfo: { flex: 1, paddingRight: 16 },
	notifLabel: { fontSize: 15, fontWeight: '500' },
	notifDesc: { fontSize: 12, marginTop: 1 },
	linkRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingVertical: 14,
		borderBottomWidth: 1,
	},
	linkLabel: { fontSize: 15 },
	linkChevron: { fontSize: 22, fontWeight: '300' },
	signOutButton: {
		paddingVertical: 14,
		alignItems: 'center',
		borderRadius: 12,
		backgroundColor: 'transparent',
	},
	signOutText: { fontSize: 16, fontWeight: '600' },
});
