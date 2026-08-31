import { View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/lib/nova-ui';
import { AvatarDisplay } from '../../src/components/avatar/AvatarDisplay';
import { AvatarState } from '../../src/lib/nova-ui';
import { Button } from '../../src/components/ui';
import { useTasks } from '../../src/store/tasks/useTasks';
import { useMemories } from '../../src/store/memory/useMemories';
import { mockReminders } from '../../src/mock/data';

export default function HomeScreen() {
 const { theme } = useTheme();
 const router = useRouter();
 const { stats: taskStats } = useTasks();
 const { stats: memoryStats } = useMemories();

 const today = new Date();
 const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
 const hour = today.getHours();
 const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

 return (
 <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
 <StatusBar barStyle="light-content" />
 <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
 <Text style={[styles.greeting, { color: theme.colors.text }]}>{greeting}</Text>
 <Text style={[styles.date, { color: theme.colors.textSecondary }]}>{dateStr}</Text>

 {/* Avatar */}
 <View style={[styles.avatarContainer, { backgroundColor: theme.colors.surface }]}>
 <AvatarDisplay state={AvatarState.IDLE} />
 <Text style={[styles.avatarStatus, { color: theme.colors.success }]}>Ready</Text>
 </View>

 <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
 How can I help you today?
 </Text>

 {/* CTA to converse */}
 <Button
 title="Tap to talk"
 onPress={() => router.push('/converse')}
 size="lg"
 style={styles.cta}
 />

 {/* Today's overview */}
 <View style={styles.overview}>
 <View style={[styles.overviewItem, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
 <Text style={styles.overviewIcon}>📅</Text>
 <Text style={[styles.overviewLabel, { color: theme.colors.textSecondary }]}>Reminders</Text>
 <Text style={[styles.overviewCount, { color: theme.colors.text }]}>{mockReminders.length}</Text>
 </View>
 <View style={[styles.overviewItem, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
 <Text style={styles.overviewIcon}>✅</Text>
 <Text style={[styles.overviewLabel, { color: theme.colors.textSecondary }]}>Tasks</Text>
 <Text style={[styles.overviewCount, { color: theme.colors.text }]}>{taskStats.pending + taskStats.inProgress}</Text>
 </View>
 <View style={[styles.overviewItem, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
 <Text style={styles.overviewIcon}>💭</Text>
 <Text style={[styles.overviewLabel, { color: theme.colors.textSecondary }]}>Memories</Text>
 <Text style={[styles.overviewCount, { color: theme.colors.text }]}>{memoryStats.total}</Text>
 </View>
 </View>
 </ScrollView>
 </View>
 );
}

const styles = StyleSheet.create({
 container: {
 flex: 1,
 },
 scrollContent: {
 flexGrow: 1,
 padding: 16,
 },
 greeting: {
 fontSize: 24,
 fontWeight: '700',
 marginBottom: 4,
 },
 date: {
 fontSize: 16,
 marginBottom: 24,
 },
 avatarContainer: {
 height: 300,
 borderRadius: 24,
 alignItems: 'center',
 justifyContent: 'center',
 marginBottom: 16,
 },
 avatarStatus: {
 marginTop: 12,
 fontSize: 14,
 fontWeight: '600',
 },
 subtitle: {
 fontSize: 16,
 textAlign: 'center',
 marginBottom: 24,
 },
 cta: {
 marginBottom: 32,
 },
 overview: {
 flexDirection: 'row',
 gap: 12,
 paddingBottom: 16,
 },
 overviewItem: {
 flex: 1,
 padding: 16,
 borderRadius: 16,
 borderWidth: 1,
 alignItems: 'center',
 },
 overviewIcon: {
 fontSize: 24,
 marginBottom: 4,
 },
 overviewLabel: {
 fontSize: 12,
 },
 overviewCount: {
 fontSize: 18,
 fontWeight: '700',
 },
});
