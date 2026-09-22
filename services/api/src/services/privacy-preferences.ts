/**
 * Privacy preferences — the reader the write sites were missing.
 *
 * `privacy_preferences` has carried `save_conversations`, `save_recordings`,
 * `save_transcripts`, `save_memories`, `cloud_processing` and `local_processing`
 * since the schema was written. Every one of them is rendered as a working switch
 * under **Profile → Privacy controls**, and until this module existed the server read
 * **none** of them: the routes below stored everything regardless. A user who turned
 * "Save recordings" off was still recorded, which is the most serious version of the
 * pattern this project keeps producing — not a missing feature, but a privacy control
 * that lies.
 *
 * ## The defaults, and why they are not the column defaults
 *
 * A user with no `privacy_preferences` row has never opened Privacy controls, so the
 * schema defaults apply: everything on, cloud processing on. That is what
 * `getPrivacyPreferences` returns. It is deliberately *not* "deny by default": an
 * account created before this module existed has no row and must not suddenly stop
 * being able to record.
 *
 * ## Cloud versus on-device processing
 *
 * Speech-to-text and the language model are provider calls — there is no on-device
 * model in this build. So `cloudProcessing: false` and `localProcessing: true` are
 * requests the deployment cannot satisfy. `assertProcessingSupported` refuses them
 * with an explanation instead of accepting a stored preference that changes nothing,
 * because "your voice will not leave this device" is exactly the promise a user must
 * not be given falsely. The switches are presented as unavailable in the app to match.
 */
import { eq } from 'drizzle-orm';
import { privacyPreferences } from '@nova/database';
import { logger } from '../utils/logger.js';
import type { getDb } from '../db/connection.js';

type Db = ReturnType<typeof getDb>;

export interface PrivacyPreferences {
	saveConversations: boolean;
	saveRecordings: boolean;
	saveTranscripts: boolean;
	saveMemories: boolean;
	cloudProcessing: boolean;
	localProcessing: boolean;
}

/** What a user who has never opened Privacy controls gets. Mirrors the columns. */
export const PRIVACY_DEFAULTS: PrivacyPreferences = {
	saveConversations: true,
	saveRecordings: true,
	saveTranscripts: true,
	saveMemories: true,
	cloudProcessing: true,
	localProcessing: false,
};

/**
 * Reads one user's preferences. Never throws: a lookup failure falls back to the
 * defaults and is logged, because failing *closed* here would silently stop a user's
 * recordings from being saved on a transient database error.
 */
export async function getPrivacyPreferences(
	db: Db,
	userId: string,
): Promise<PrivacyPreferences> {
	try {
		const [row] = await db
			.select({
				saveConversations: privacyPreferences.saveConversations,
				saveRecordings: privacyPreferences.saveRecordings,
				saveTranscripts: privacyPreferences.saveTranscripts,
				saveMemories: privacyPreferences.saveMemories,
				cloudProcessing: privacyPreferences.cloudProcessing,
				localProcessing: privacyPreferences.localProcessing,
			})
			.from(privacyPreferences)
			.where(eq(privacyPreferences.userId, userId))
			.limit(1);

		if (!row) return { ...PRIVACY_DEFAULTS };
		return {
			saveConversations: row.saveConversations ?? PRIVACY_DEFAULTS.saveConversations,
			saveRecordings: row.saveRecordings ?? PRIVACY_DEFAULTS.saveRecordings,
			saveTranscripts: row.saveTranscripts ?? PRIVACY_DEFAULTS.saveTranscripts,
			saveMemories: row.saveMemories ?? PRIVACY_DEFAULTS.saveMemories,
			cloudProcessing: row.cloudProcessing ?? PRIVACY_DEFAULTS.cloudProcessing,
			localProcessing: row.localProcessing ?? PRIVACY_DEFAULTS.localProcessing,
		};
	} catch (err) {
		// Fail **open**, and loudly.
		//
		// Failing closed would be the "safer" reading of a privacy control, but it means
		// a transient database blip stops every recording, memory and conversation being
		// saved — turning a short outage into data loss for users who never changed a
		// setting. So the defaults (everything on) are returned and the product keeps
		// working.
		//
		// It must not be *silent*, though: this branch means a user who switched
		// something off is, for the duration of the failure, being recorded anyway. An
		// operator has to be able to see that, and the log line is the only trace.
		logger.error(
			{ err, userId },
			'Could not read privacy preferences; falling back to the defaults (all saving ON) for this request',
		);
		return { ...PRIVACY_DEFAULTS };
	}
}

/**
 * Throws when a client asks for a processing mode this deployment cannot provide.
 *
 * Returns `null` when the request is satisfiable. Callers pass the *incoming* patch,
 * not the stored row, so this only rejects a deliberate change.
 */
export function processingUnsupported(patch: {
	cloudProcessing?: boolean;
	localProcessing?: boolean;
}): { code: string; message: string } | null {
	if (patch.localProcessing === true) {
		return {
			code: 'LOCAL_PROCESSING_UNAVAILABLE',
			message:
				'On-device processing is not available in this build: speech-to-text and the ' +
				'language model run on NOVA’s servers. Enabling it would not change where your ' +
				'audio is processed, so it is refused rather than stored.',
		};
	}
	if (patch.cloudProcessing === false) {
		// Not satisfiable without on-device models. Accepting it would let the app tell a
		// user their voice never leaves the device while every turn is still sent to a
		// provider.
		return {
			code: 'CLOUD_PROCESSING_REQUIRED',
			message:
				'NOVA cannot currently answer without sending your audio to its servers, so ' +
				'cloud processing cannot be switched off. Use “Save recordings” and ' +
				'“Save transcripts” to control what is kept, or delete the recording afterwards.',
		};
	}
	return null;
}
