/**
 * LEA-015 — Translation tab screen.
 *
 * Wraps the TranslationComposer component in a standalone screen
 * mounted under (tabs)/translate for the mobile app.
 */

import { useTheme } from '../../src/lib/nova-ui';
import { TranslationComposer } from '../../src/components/translation/TranslationComposer';
import { useAuth } from '../../src/store/auth';

export default function TranslateScreen(): React.JSX.Element {
	const { theme } = useTheme();
	const { user } = useAuth();

	return (
		<TranslationComposer
			userId={user?.id ?? 'anonymous'}
			onTranslationComplete={(result) => {
				// TODO: emit realtime event translation.completed (LEA-021)
				console.log('[LEA-015] translation.completed', result);
			}}
		/>
	);
}
