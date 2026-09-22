/**
 * NOVA API — composing the follow-up sentence.
 *
 * The engine never calls a model to write a follow-up. Every sentence here is a
 * function of one real row: the item's own title, plus ordinary words. That choice
 * buys three things at once — there is nothing to hallucinate, the feature costs
 * nothing to run and works with no LLM credit, and the output survives the daily
 * briefing's grounding guard by construction rather than by luck. The guard is still
 * run over the result (see `composeFollowUpForSnapshot`), as a self-check that fails
 * loudly if a future edit starts generating prose here.
 *
 * It is deliberately free of clock times, weekdays and month names. Those would be
 * generated rather than drawn from the user's rows, so the guard would refuse them —
 * correctly. What is left names the item and asks the one question worth asking.
 */
import type { FollowUpCandidate } from './follow-up.js';
import type { UserContextFacts } from './user-context.js';
import { toBriefingSpeech } from './briefing-speech.js';

/**
 * The question every follow-up ends with. It names the three things the user can
 * actually do, which is what makes the message actionable rather than a report card.
 */
export const FOLLOW_UP_QUESTION =
	'Do you want to finish it now, push it to a later day, or leave it as is?';

export interface RenderedFollowUp {
	/** One sentence, from a real row. */
	title: string;
	/** The question. */
	body: string;
	/** `title` and `body` together: what a speech engine reads. */
	message: string;
}

/** The observation, per reason. Ordinary words and the item's own title only. */
function observation(candidate: FollowUpCandidate, title: string): string {
	switch (candidate.reason) {
		case 'task-overdue':
			return `You planned to finish ${title} and it is still open.`;
		case 'task-due-today':
			return `You planned to finish ${title} today and it is still open.`;
		case 'task-stale':
			return `You added ${title} a while ago and it is still pending.`;
		case 'reminder-missed':
			return `Your reminder ${title} went off and has not been dismissed.`;
		case 'reminder-rescheduled':
			return `You have moved ${title} more than once and it is still waiting.`;
	}
}

/**
 * Composes the follow-up. Returns null when the title sanitises away to nothing, in
 * which case there is nothing honest to say and the engine raises nothing.
 *
 * The title goes through [toBriefingSpeech] first — the same normaliser every
 * briefing and spoken reply uses — because a user's own task title can legitimately
 * contain an emoji or a URL and neither belongs in a spoken sentence.
 */
export function renderFollowUp(candidate: FollowUpCandidate): RenderedFollowUp | null {
	const title = toBriefingSpeech(candidate.title ?? '').trim();
	if (!title) return null;
	const opening = observation(candidate, title);
	return { title: opening, body: FOLLOW_UP_QUESTION, message: `${opening} ${FOLLOW_UP_QUESTION}` };
}

/**
 * True when the item the follow-up names is still present in the snapshot it was
 * chosen from. The last line of defence for "a follow-up that names an item must
 * name a real row": no id, no message.
 */
export function namesARealRow(
	candidate: FollowUpCandidate,
	facts: UserContextFacts,
): boolean {
	const source: readonly { id: string }[] =
		candidate.itemType === 'task' ? facts.tasks : facts.reminders;
	return source.some((row) => row.id === candidate.itemId);
}
