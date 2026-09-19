/**
 * NOVA API — the shared anti-fabrication vocabulary.
 *
 * Both grounding guards in this service — the daily briefing's
 * (`briefing.ts`) and the meeting summary's (`meeting-summary.ts`) — refuse a
 * model draft that contains a capitalised word which is neither in the user's
 * own data nor ordinary English. That "ordinary English" list is the rule's one
 * tunable part, and it used to exist twice: a briefing copy and a summary copy.
 * Two copies of the same safety list drift, and a word added to one silently
 * becomes a rejection in the other.
 *
 * So it lives here, once. `briefing.ts` imports it unchanged (its contents are
 * exactly what that module used to declare locally), and `meeting-summary.ts`
 * imports it and adds the words a written summary uses that a spoken briefing
 * does not.
 *
 * ## Why ordinary words need to be listed at all
 *
 * The rule cannot tell "Meera approved the budget" from "Several people
 * approved the budget" by shape alone — both are a capitalised word at the
 * start of a sentence. Position-based exemption (only check mid-sentence
 * capitalisation) would be wrong in the other direction: an invented name hides
 * perfectly well at the start of a sentence. Listing the ordinary words is the
 * conservative middle: anything not on the list and not in the user's data is
 * treated as a name the model made up.
 *
 * ## What belongs here, and what does not
 *
 * Function words, pronouns, discourse markers and generic nouns. What must
 * **never** be added: names, organisations, places, products, or domain nouns
 * specific enough to be a fact ("Bangalore", "Priya", "Nova", "acme"). Adding
 * one of those would let the fabricated version of it through the guard, which
 * is the single failure this whole mechanism exists to prevent.
 */
export const ORDINARY_CAPITALIZED: ReadonlySet<string> = new Set([
	'a', 'about', 'after', 'again', 'all', 'also', 'an', 'and', 'another', 'any',
	'are', 'around', 'as', 'at', 'be', 'before', 'but', 'by', 'can', 'clear',
	'currently', 'do', 'due', 'each', 'else', 'even', 'evening', 'every',
	'everything', 'finally', 'first', 'firstly', 'flagged', 'for', 'from',
	'get', 'good', 'greeting', 'had', 'has', 'have', 'he', 'hello', 'here',
	'hey', 'hi', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'just',
	'last', 'later', 'let', 'look', 'looking', 'made', 'make', 'maybe',
	'meanwhile', 'might', 'more', 'morning', 'most', 'my', 'need', 'needs',
	'next', 'no', 'not', 'nothing', 'now', 'of', 'okay', 'on', 'one', 'only',
	'or', 'other', 'otherwise', 'our', 'out', 'overdue', 'perhaps', 'plus',
	'quick', 'quickly', 'really', 'reminder', 'reminders', 'right', 'scheduled',
	'second', 'see', 'she', 'shortly', 'should', 'since', 'so', 'some', 'start',
	'still', 'straight', 'summary', 'take', 'task', 'tasks', 'than', 'that',
	'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things',
	'third', 'this', 'those', 'three', 'through', 'to', 'today', 'together',
	'tomorrow', 'tonight', 'too', 'two', 'under', 'until', 'up', 'upcoming',
	'us', 'waiting', 'want', 'wanted', 'was', 'we', 'well', 'were', 'what',
	'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'worth',
	'would', 'yes', 'yet', 'you', 'your', 'yours',
]);
