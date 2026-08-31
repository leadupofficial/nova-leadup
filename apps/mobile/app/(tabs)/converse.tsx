/**
 * NOVA — Converse Screen (primary live agent)
 * Section 5.6 of blueprint.
 *
 * Features: avatar with state machine, live transcript, voice button,
 * quick actions, captions toggle.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	ScrollView,
	StyleSheet,
	Animated,
	StatusBar,
	KeyboardAvoidingView,
	Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/lib/nova-ui';
import { AvatarDisplay } from '../../src/components/avatar/AvatarDisplay';
import { AvatarState } from '../../src/lib/nova-ui';
import { useAuth } from '../../src/store/auth';
import {
	createConversationState,
	addUserMessage,
	addAssistantMessage,
	setTyping,
	clearConversation,
	type Message,
	type ConversationState,
} from '../../src/store/conversation/conversationSlice';

type ScreenState = {
	conversation: ConversationState;
	avatarState: AvatarState;
	inputText: string;
	captionsOn: boolean;
	isRecording: boolean;
	recordingTime: number;
};

const INITIAL: ScreenState = {
	conversation: createConversationState(),
	avatarState: AvatarState.IDLE,
	inputText: '',
	captionsOn: true,
	isRecording: false,
	recordingTime: 0,
};

export default function ConverseScreen(): React.JSX.Element {
	const { theme } = useTheme();
	const router = useRouter();
	const { isAuthenticated } = useAuth();

	const [state, setState] = useState<ScreenState>(INITIAL);
	const scrollRef = useRef<ScrollView>(null);
	const recordingRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const pulseAnim = useRef(new Animated.Value(1)).current;

	// Redirect to onboarding if not authenticated
	useEffect(() => {
		if (!isAuthenticated) {
			router.replace('/onboarding');
		}
	}, [isAuthenticated, router]);

	// Recording timer
	useEffect(() => {
		if (state.isRecording) {
			recordingRef.current = setInterval(() => {
				setState((s) => ({ ...s, recordingTime: s.recordingTime + 1 }));
			}, 1000);
		} else {
			if (recordingRef.current) clearInterval(recordingRef.current);
			setState((s) => ({ ...s, recordingTime: 0 }));
		}
		return () => {
			if (recordingRef.current) clearInterval(recordingRef.current);
		};
	}, [state.isRecording]);

	// Auto-scroll on new messages
	useEffect(() => {
		if (state.conversation.messages.length > 0) {
			setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
		}
	}, [state.conversation.messages.length]);

	// Pulse animation while listening
	useEffect(() => {
		if (state.isRecording) {
			const pulse = Animated.loop(
				Animated.sequence([
					Animated.timing(pulseAnim, { toValue: 1.15, duration: 800, useNativeDriver: true }),
					Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
				])
			);
			pulse.start();
			return () => pulse.stop();
		}
		pulseAnim.setValue(1);
	}, [state.isRecording, pulseAnim]);

	const formatTime = (seconds: number): string => {
		const m = Math.floor(seconds / 60).toString().padStart(2, '0');
		const s = (seconds % 60).toString().padStart(2, '0');
		return `${m}:${s}`;
	};

	const simulateConversation = useCallback(
		async (userText: string) => {
			setState((s) => ({
				...s,
				conversation: addUserMessage(s.conversation, userText),
				inputText: '',
			}));
			setState((s) => ({ ...s, conversation: setTyping(s.conversation, true), avatarState: AvatarState.THINKING }));

			await new Promise((r) => setTimeout(r, 1200));

			const lower = userText.toLowerCase();
			let response: string;
			if (lower.includes('remind') || lower.includes('reminder')) {
				response = 'Sure! I\'ll create a reminder for you. What should I remind you about, and when?';
			} else if (lower.includes('task') || lower.includes('todo')) {
				response = 'I\'ll create a task for that. What\'s the priority and due date?';
			} else if (lower.includes('translate')) {
				response = 'Opening translation panel. What would you like to translate?';
				setTimeout(() => router.push('/(tabs)/translate'), 1000);
			} else if (lower.includes('hello') || lower.includes('hi') || lower.includes('namaste') || lower.includes('vanakkam')) {
				response = 'Hello! How can I help you today? I can help with reminders, tasks, translations, and more.';
			} else {
				response = 'I understand. Is there anything specific you\'d like me to help with — a reminder, task, or translation?';
			}

			setState((s) => ({
				...s,
				conversation: addAssistantMessage(s.conversation, response),
				avatarState: AvatarState.SPEAKING,
			}));

			setTimeout(() => {
				setState((s) => ({ ...s, avatarState: AvatarState.IDLE }));
			}, 3000);
		},
		[router]
	);

	const toggleRecording = useCallback(() => {
		if (state.isRecording) {
			setState((s) => ({ ...s, isRecording: false, avatarState: AvatarState.THINKING }));
			setTimeout(() => {
				setState((s) => ({
					...s,
					avatarState: AvatarState.SPEAKING,
					conversation: addAssistantMessage(s.conversation, 'I\'m processing your voice input. What would you like me to do?'),
				}));
				setTimeout(() => {
					setState((s) => ({ ...s, avatarState: AvatarState.IDLE }));
				}, 2000);
			}, 1000);
		} else {
			setState((s) => ({ ...s, isRecording: true, avatarState: AvatarState.LISTENING }));
		}
	}, [state.isRecording]);

	const sendText = useCallback(() => {
		const text = state.inputText.trim();
		if (!text || state.conversation.isTyping) return;
		simulateConversation(text);
	}, [state.inputText, state.conversation.isTyping, simulateConversation]);

	const handleQuickAction = useCallback(
		(action: string) => {
			const actionTexts: Record<string, string> = {
				'Create Task': 'Create a new task for me',
				'Set Reminder': 'Set a reminder',
				'Search Memory': 'Search my memories',
				'Record Meeting': 'Start recording this meeting',
				'Translate': 'Translate some text',
			};
			simulateConversation(actionTexts[action] || action);
		},
		[simulateConversation]
	);

	const handleClear = useCallback(() => {
		setState((s) => ({
			...s,
			conversation: clearConversation(s.conversation),
			avatarState: AvatarState.IDLE,
		}));
	}, []);

	const QUICK_ACTIONS = ['Create Task', 'Set Reminder', 'Search Memory', 'Record Meeting', 'Translate'];

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
				<StatusBar barStyle="light-content" />

				{/* Header */}
				<View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
					<View style={styles.headerCenter}>
						<Text style={[styles.headerTitle, { color: theme.colors.text }]}>NOVA</Text>
						{state.isRecording && (
							<View style={styles.recordingBadge}>
								<View style={styles.recordingDot} />
								<Text style={styles.recordingText}>REC {formatTime(state.recordingTime)}</Text>
							</View>
						)}
					</View>
					<View style={styles.headerActions}>
						<TouchableOpacity
							onPress={() => setState((s) => ({ ...s, captionsOn: !s.captionsOn }))}
							style={[
								styles.captionToggle,
								{ backgroundColor: state.captionsOn ? `${theme.colors.primary}20` : 'transparent' },
							]}
							accessibilityLabel={state.captionsOn ? 'Turn off captions' : 'Turn on captions'}
						>
							<Text
								style={[
									styles.captionText,
									{ color: state.captionsOn ? theme.colors.primary : theme.colors.textSecondary },
								]}
							>
								CC
							</Text>
						</TouchableOpacity>
						<TouchableOpacity onPress={handleClear} style={styles.clearButton}>
							<Text style={[styles.clearText, { color: theme.colors.textSecondary }]}>Clear</Text>
						</TouchableOpacity>
					</View>
				</View>

				{/* Avatar + Caption */}
				<View style={styles.avatarContainer}>
					<View style={styles.avatarWrapper}>
						<AvatarDisplay state={state.avatarState} />
					</View>
					{state.isRecording && (
						<View style={[styles.statusPill, { backgroundColor: `${theme.colors.danger}20` }]}>
							<Animated.View
								style={[
									styles.pulseRing,
									{ backgroundColor: theme.colors.danger, transform: [{ scale: pulseAnim }] },
								]}
							/>
							<Text style={[styles.statusText, { color: theme.colors.danger }]}>
								{state.avatarState === AvatarState.LISTENING
									? 'Listening...'
									: state.avatarState === AvatarState.THINKING
										? 'Thinking...'
										: state.avatarState === AvatarState.SPEAKING
											? 'Speaking...'
											: 'Recording...'}
							</Text>
						</View>
					)}
					{state.captionsOn &&
						state.avatarState === AvatarState.SPEAKING &&
						state.conversation.messages.length > 0 && (
							<View
								style={[styles.captionBox, { backgroundColor: `${theme.colors.surface}DD` }]}
							>
								<Text style={[styles.captionText, { color: theme.colors.text }]}>
									{state.conversation.messages[state.conversation.messages.length - 1]?.content}
								</Text>
							</View>
						)}
				</View>

				{/* Transcript */}
				<ScrollView
					ref={scrollRef}
					style={styles.messagesScroll}
					contentContainerStyle={styles.messagesContent}
					showsVerticalScrollIndicator={false}
				>
					<View style={styles.transcriptContainer}>
						{state.conversation.messages.map((msg) => (
							<View
								key={msg.id}
								style={[
									styles.messageBubble,
									msg.role === 'user'
										? [styles.userBubble, { backgroundColor: theme.colors.primary }]
										: [
												styles.assistantBubble,
												{
													backgroundColor: theme.colors.surface,
													borderColor: theme.colors.border,
												},
											],
								]}
							>
								<Text
									style={[
										styles.messageRole,
										{
											color:
												msg.role === 'user'
													? 'rgba(255,255,255,0.7)'
													: theme.colors.textSecondary,
										},
									]}
								>
									{msg.role === 'user' ? 'You' : 'NOVA'}
								</Text>
								<Text
									style={[
										styles.messageText,
										{ color: msg.role === 'user' ? '#FFFFFF' : theme.colors.text },
									]}
								>
									{msg.content}
								</Text>
							</View>
						))}
						{state.conversation.isTyping && (
							<View
								style={[
									styles.typingIndicator,
									{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
								]}
							>
								<View style={styles.typingDots}>
									<View style={[styles.dot, { backgroundColor: theme.colors.primary }]} />
									<View style={[styles.dot, { backgroundColor: theme.colors.primary }]} />
									<View style={[styles.dot, { backgroundColor: theme.colors.primary }]} />
								</View>
							</View>
						)}
					</View>
				</ScrollView>

				{/* Quick Actions */}
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					style={styles.quickActions}
				>
					{QUICK_ACTIONS.map((action) => (
						<TouchableOpacity
							key={action}
							onPress={() => handleQuickAction(action)}
							style={[
								styles.quickActionButton,
								{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
							]}
							accessibilityLabel={action}
						>
							<Text
								style={[styles.quickActionText, { color: theme.colors.textSecondary }]}
							>
								{action}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>

				{/* Input Bar */}
				<View
					style={[
						styles.inputBar,
						{ backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
					]}
				>
					<TextInput
						style={[styles.textInput, { color: theme.colors.text }]}
						placeholder={state.isRecording ? 'Listening...' : 'Type a message...'}
						placeholderTextColor="#64748B"
						value={state.isRecording ? '' : state.inputText}
						onChangeText={(text) =>
							setState((s) => ({ ...s, inputText: text }))
						}
						onSubmitEditing={sendText}
						editable={!state.isRecording && !state.conversation.isTyping}
						accessibilityLabel="Message input"
					/>
					{!state.isRecording ? (
						<TouchableOpacity
							onPress={sendText}
							disabled={!state.inputText.trim() || state.conversation.isTyping}
							style={[
								styles.sendButton,
								{
									backgroundColor: state.inputText.trim()
										? theme.colors.primary
										: theme.colors.border,
								},
							]}
							accessibilityLabel="Send message"
						>
							<Text style={styles.sendButtonText}>↑</Text>
						</TouchableOpacity>
					) : (
						<TouchableOpacity
							onPress={toggleRecording}
							style={[styles.voiceButton, { backgroundColor: theme.colors.danger }]}
							accessibilityLabel="Stop recording"
						>
							<Text style={styles.voiceButtonText}>⏹</Text>
						</TouchableOpacity>
					)}
				</View>

				{/* Voice FAB — always accessible */}
				<TouchableOpacity
					onPress={toggleRecording}
					style={[styles.voiceFab, { backgroundColor: theme.colors.primary }]}
					accessibilityLabel={state.isRecording ? 'Stop recording' : 'Start voice recording'}
				>
					<Text style={styles.voiceFabIcon}>{state.isRecording ? '⏹' : '🎙'}</Text>
				</TouchableOpacity>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 16,
		paddingTop: 12,
		borderBottomWidth: 1,
	},
	headerCenter: { alignItems: 'center', flex: 1 },
	headerTitle: { fontSize: 18, fontWeight: '700', letterSpacing: 1 },
	headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	recordingBadge: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		marginTop: 2,
	},
	recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
	recordingText: { color: '#EF4444', fontSize: 11, fontWeight: '600', letterSpacing: 1 },
	captionToggle: {
		width: 32,
		height: 32,
		borderRadius: 16,
		alignItems: 'center',
		justifyContent: 'center',
	},
	captionText: { fontSize: 12, fontWeight: '700' },
	clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
	clearText: { fontSize: 13, fontWeight: '500' },
	avatarContainer: { alignItems: 'center', paddingVertical: 8 },
	avatarWrapper: { height: 180, justifyContent: 'center', alignItems: 'center' },
	statusPill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 20,
		marginTop: 8,
	},
	pulseRing: {
		width: 8,
		height: 8,
		borderRadius: 4,
	},
	statusText: { fontSize: 13, fontWeight: '600' },
	captionBox: {
		marginTop: 12,
		padding: 14,
		borderRadius: 16,
		maxWidth: '90%',
		alignItems: 'center',
	},
	captionText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
	messagesScroll: { flex: 1 },
	messagesContent: { paddingHorizontal: 20, paddingBottom: 12, paddingTop: 8 },
	transcriptContainer: { gap: 10 },
	messageBubble: {
		padding: 12,
		borderRadius: 16,
		maxWidth: '82%',
	},
	userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
	assistantBubble: {
		alignSelf: 'flex-start',
		borderBottomLeftRadius: 4,
		borderWidth: 1,
	},
	messageRole: {
		fontSize: 10,
		fontWeight: '600',
		marginBottom: 3,
		textTransform: 'uppercase',
		letterSpacing: 0.5,
	},
	messageText: { fontSize: 15, lineHeight: 22 },
	typingIndicator: {
		alignSelf: 'flex-start',
		padding: 12,
		borderRadius: 16,
		borderBottomLeftRadius: 4,
		borderWidth: 1,
	},
	typingDots: { flexDirection: 'row', gap: 4, alignItems: 'center' },
	dot: { width: 6, height: 6, borderRadius: 3 },
	quickActions: {
		flexDirection: 'row',
		paddingHorizontal: 16,
		paddingVertical: 8,
		gap: 8,
	},
	quickActionButton: {
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 20,
		borderWidth: 1,
	},
	quickActionText: { fontSize: 13, fontWeight: '600', whiteSpace: 'nowrap' },
	inputBar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		padding: 12,
		paddingBottom: 28,
		borderTopWidth: 1,
	},
	textInput: {
		flex: 1,
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 24,
		fontSize: 15,
		maxHeight: 120,
		backgroundColor: '#0B1020',
		borderWidth: 1,
		borderColor: '#1E293B',
	},
	sendButton: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
	},
	sendButtonText: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
	voiceButton: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: 'center',
		justifyContent: 'center',
	},
	voiceButtonText: { color: '#FFFFFF', fontSize: 18 },
	voiceFab: {
		position: 'absolute',
		bottom: 100,
		right: 20,
		width: 52,
		height: 52,
		borderRadius: 26,
		alignItems: 'center',
		justifyContent: 'center',
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.3,
		shadowRadius: 8,
		elevation: 6,
	},
	voiceFabIcon: { fontSize: 22 },
});
