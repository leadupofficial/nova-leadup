/**
 * NOVA API — the assistant's write tools: what the model is offered, and the
 * bounded loop that runs them.
 *
 * The conversation and voice routes can already *read* the user's tasks,
 * reminders and memories (`./user-context.js`), but until this module existed
 * the assistant had no way to *create* any of them. Ask it "remind me to call
 * the bank tomorrow at 5pm" and it correctly answered that it could not create
 * reminders — because it genuinely could not, and told the user to add it
 * manually. A companion that cannot take a reminder is not a companion.
 *
 * Tool execution itself lives in `./assistant-tool-executor.js` (which is where
 * the database lives, and where the authenticated user id is applied) and date
 * resolution in `./assistant-datetime.js`.
 */
import { chatCompletion, type ChatMessage, type ToolDefinition } from './ai.js';
import { logger } from '../utils/logger.js';
import { env } from '../utils/env.js';
import {
	executeToolUses,
	toolSummaryText,
	toToolResultBlock,
	type ExecutedToolCall,
} from './assistant-tool-executor.js';

/**
 * Instruction appended to the system prompt wherever the tools are offered. It
 * is not part of the persona prompt because the routes that do not offer tools
 * must not advertise them.
 */
export const ASSISTANT_TOOLS_PROMPT =
	'You can manage the user\'s own things with tools: create_reminder, update_reminder, ' +
	'cancel_reminder, create_task, complete_task, reopen_task, resolve_follow_up, save_memory ' +
	'and forget_memory. ' +
	'Creation and management are both yours — never tell them to edit, cancel or complete ' +
	'something themselves, and never say you are unable to create, edit, cancel, complete, ' +
	'reopen, remember or forget things. When they ask you to remind them of something, change ' +
	'or cancel a reminder, add a task, tick a task off, bring a task back, remember something ' +
	'about them or forget something, call the matching tool. ' +
	'When they correct something you already knew, call save_memory with the new fact exactly ' +
	'as they stated it: a memory that states the same thing differently is replaced ' +
	'automatically, so there is only ever one current version, and saying "updated" without ' +
	'calling the tool leaves both versions in place. When they ask you to forget something, ' +
	'call forget_memory with the fact in their own words — saved memories are matched by what ' +
	'they say, not by an id — and if its result says nothing matched, tell them you had nothing ' +
	'saved about that rather than claiming you deleted it. ' +
	'To move a reminder to a time relative to now — "remind me in an hour", "snooze the ' +
	'plumber reminder by thirty minutes", "not now, remind me after lunch" — call ' +
	'update_reminder with `in_minutes`, computed from the current time given above; use ' +
	'`trigger_at` only when they named an actual day and time. ' +
	// ── Recurrence (§14) ─────────────────────────────────────────────────
	// Until this existed the model refused every repeating request — measured on
	// the acceptance run, "remind me every Monday" was answered *"I can only set it
	// for a specific date and time rather than a recurring schedule."* — because
	// the tool contract had no field for a repeat and the executor wrote
	// `repeatRule: null` on every insert. It is offered now, in exactly the three
	// forms the phone can actually repeat with the app closed.
	'When they ask for something that repeats — "remind me every Monday", "every day at ' +
	'7", "the first of every month" — send `repeat_rule` as well as `trigger_at`, and make ' +
	'`trigger_at` the FIRST time it should go off. `repeat_rule` takes exactly one of three ' +
	'forms: `FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=MO` (one weekday, from MO, TU, WE, TH, FR, SA ' +
	'and SU) or `FREQ=MONTHLY;BYMONTHDAY=15` (a day of the month). Say the recurrence back ' +
	'in words when you confirm — "every Monday" — and when the day of the month is the 29th, ' +
	'30th or 31st, say that a month without that day is skipped. A repeat that is not one of ' +
	'these three — every other week, every three days, the last Friday of the month — is not ' +
	'one NOVA can keep, so say you can repeat daily, weekly on a weekday, or monthly on a ' +
	'day, and offer the closest of those rather than inventing a rule. ' +
	'If you have followed up about something they planned ' +
	'and they answer it — "leave it", "not now", "remind me later" — call resolve_follow_up so ' +
	'you stop asking; do not decide on their behalf that they are done with it. It records the ' +
	'answer only and moves nothing, so when what they want is the reminder itself pushed back ' +
	'("not now, remind me after lunch"), call update_reminder with in_minutes as well. ' +
	'A tool that acts on an existing task or reminder takes its `id` ' +
	'from the list of their tasks and reminders above; use the real id you were given, and if ' +
	'you do not have one, ask them which one rather than inventing an id or guessing. ' +
	'Marking a task complete is a claim that the work is done — call complete_task only when ' +
	'they told you it is, and accept its result as the truth instead of saying a task is ' +
	'finished when the tool did not run. Call a tool only when they clearly asked for that ' +
	'action; do not invent reminders or tasks they did not ask for. If a tool result says ok ' +
	'is false, tell them plainly that it failed and why. If it succeeded, confirm what you ' +
	'changed and repeat the resolved date and time when there is one. Use the current time and ' +
	'timezone given above to resolve "tomorrow", "next Monday" and similar phrasing. ' +
	// ── Never invent a time the user did not give ────────────────────────
	// The instruction above says to *resolve* a day reference and said nothing about
	// a day given **without** a time, so the model filled the hour with a
	// plausible-looking default. Measured in the §31 run, with the row to prove it:
	// the user said only *"tomorrow I need to finish the website proposal and call
	// the client"*, the reply was *"Both tasks are set for tomorrow by six o'clock
	// in the evening"*, and both rows were written with `due_at` 18:00 IST — a
	// commitment time nobody stated. A time in the database is indistinguishable
	// from a time the user gave, so this is the same class of fabrication as
	// claiming an action that never ran, and it needs the same explicitness.
	'A day on its own is not a time. When they gave you a day but no time — ' +
	'"tomorrow", "on Wednesday", "next week" — do NOT choose an hour for them: ' +
	'use a time only if they named one, and otherwise either ask for it in one ' +
	'short question or record the item with no time at all. Never say or store a ' +
	'clock time they did not give, and never present a default as though they had ' +
	'given it. "Tomorrow morning" and "tomorrow evening" name a part of the day: use ' +
	'their own established preference for that part of the day if you have been told ' +
	'one, and ask if you have not. ' +
	// ── Never narrate the machinery ──────────────────────────────────────
	// Measured twice on the live spoken route, once per model, and both reached the
	// user verbatim: *"You're right, I apologize. Let me call the tool now. The user
	// asked me to remind them to call the client tomorrow morning, but I need to
	// clarify the time…"* — a plan, an apology and a third-person summary of the
	// request, spoken aloud as the answer, with no tool called. The turn must read
	// as an assistant talking to the person in front of it.
	'Write only to the user, in the second person. Never narrate your own ' +
	'plan, restate what they asked for in the third person, apologise for a ' +
	'"previous" reply, announce which tool you are about to call, or describe ' +
	'your reasoning — the user hears every word of this as your answer. Either ' +
	'call the tool and confirm what changed in one short sentence, or ask one ' +
	'short question. If a request is missing a detail you need, call the tool ' +
	'with what you do have when that is sensible, or ask for the missing detail ' +
	'in a single sentence — never both, and never a sentence that claims the ' +
	'action is already done.';

// ─── Permission levels (blueprint §10.1) ─────────────────────────────

/**
 * A tool's permission level, on the blueprint's 0–3 scale.
 *
 * L0 read-only — may run without confirmation.
 * L1 personal low-risk write — configurable; confirm during beta.
 * L2 external communication — always show the full payload and confirm.
 * L3 sensitive/consequential — explicit confirm plus re-authentication.
 */
export type ToolPermissionLevel = 0 | 1 | 2 | 3;

export const TOOL_LEVEL_READ_ONLY = 0 satisfies ToolPermissionLevel;
export const TOOL_LEVEL_PERSONAL_WRITE = 1 satisfies ToolPermissionLevel;
export const TOOL_LEVEL_EXTERNAL = 2 satisfies ToolPermissionLevel;
export const TOOL_LEVEL_SENSITIVE = 3 satisfies ToolPermissionLevel;

/**
 * The single source of truth for what each assistant tool is allowed to do.
 *
 * It is a total map over the tool names in [ASSISTANT_TOOLS] rather than a field
 * scattered through the definitions, so a reviewer reads every tool's level in
 * one place and adding a tool to the list without classifying it is a compile
 * error (`satisfies` over `Record<AssistantToolName, …>`), not a silent
 * default. `assistant-tools.test` — the runtime half of that guarantee — fails
 * if a name appears here with no definition or vice versa.
 *
 * Today all nine are L1: they write only to the caller's own rows and reach
 * nobody else. The management verbs (`update_reminder`, `cancel_reminder`,
 * `complete_task`, `reopen_task`) are L1 for the same reason and are no
 * exception: each is reversible from the app the user already has — `Restore`
 * un-dismisses a reminder, `PATCH /tasks/:id` returns a completed task to
 * `pending` — and none of them deletes a row or tells anyone outside the
 * account anything. `resolve_follow_up` is L1 too: it records the user's own
 * answer to a question NOVA asked them, and its only effect is that NOVA stops
 * asking. `forget_memory` is L1 on the same terms: it archives the caller's own
 * memory row (`archived`, the lifecycle value the memories routes already
 * accept) rather than deleting it, so nothing is destroyed and the user can be
 * told the truth about a fact that no longer reaches the assistant. Rating them
 * L2 would be a category error (§10.1 reserves
 * that for reaching other people) and rating them L3 would demand
 * re-authentication to tick off a shopping item. The moment an L2 tool (send
 * email / WhatsApp) is offered, it belongs here as `TOOL_LEVEL_EXTERNAL`, and
 * the voice gate will demand the full payload before it can run.
 */
export const ASSISTANT_TOOL_LEVELS = {
	create_reminder: TOOL_LEVEL_PERSONAL_WRITE,
	update_reminder: TOOL_LEVEL_PERSONAL_WRITE,
	cancel_reminder: TOOL_LEVEL_PERSONAL_WRITE,
	create_task: TOOL_LEVEL_PERSONAL_WRITE,
	complete_task: TOOL_LEVEL_PERSONAL_WRITE,
	reopen_task: TOOL_LEVEL_PERSONAL_WRITE,
	save_memory: TOOL_LEVEL_PERSONAL_WRITE,
	forget_memory: TOOL_LEVEL_PERSONAL_WRITE,
	resolve_follow_up: TOOL_LEVEL_PERSONAL_WRITE,
} as const satisfies Record<string, ToolPermissionLevel>;

/** Every name the assistant may call, derived from the registry. */
export type AssistantToolName = keyof typeof ASSISTANT_TOOL_LEVELS;

export const ASSISTANT_TOOL_NAMES = Object.keys(ASSISTANT_TOOL_LEVELS) as AssistantToolName[];

/**
 * The level of a tool the model asked for.
 *
 * An unknown name is **L3**, not L0. The caller (the model) is untrusted, and
 * this is the last branch before an executor that would answer "unknown tool"
 * anyway — defaulting to "read-only, no prompt" here is how a tool added on the
 * server but forgotten in this map would run unconfirmed.
 */
export function toolPermissionLevel(name: string): ToolPermissionLevel {
	return name in ASSISTANT_TOOL_LEVELS
		? ASSISTANT_TOOL_LEVELS[name as AssistantToolName]
		: TOOL_LEVEL_SENSITIVE;
}

/**
 * The configured confirmation threshold.
 *
 * Read lazily through the `env` proxy so a test (or an operator) can change
 * `VOICE_TOOL_CONFIRM_LEVEL` and see the effect on the next turn. Default is L1
 * — see the schema comment in `utils/env.ts`.
 */
export function toolConfirmationLevel(): ToolPermissionLevel {
	return env.VOICE_TOOL_CONFIRM_LEVEL;
}

/**
 * True when [name] may not execute on the voice path until the user confirms.
 *
 * L0 is never at or above any threshold in range (0–3), so a read-only tool can
 * never be made to prompt — that is the property the voice gate depends on.
 */
export function toolRequiresConfirmation(
	name: string,
	threshold: ToolPermissionLevel = toolConfirmationLevel(),
): boolean {
	return toolPermissionLevel(name) >= threshold;
}

// ─── Device-control actions (blueprint §9.2) ─────────────────────────

/**
 * The device-control actions, and the permission level each carries.
 *
 * These execute on the phone, not on the server — `NovaDeviceControl.kt` is the
 * only thing that can open an app, dial, or change a setting — but the level is
 * a property of the action, not of where it runs, so it is classified here
 * beside [ASSISTANT_TOOL_LEVELS], sharing the same scale and the same
 * configured threshold.
 *
 * They are deliberately **not** added to [ASSISTANT_TOOLS]. This server has no
 * executor for them; offering them to the model would produce a tool call the
 * executor answers with "unknown tool", which is worse than not offering it.
 * The mobile registry
 * (`apps/mobile/lib/features/device_control/device_control_models.dart`) and the
 * Kotlin one (`DeviceControlCatalog.kt`) mirror this table, and each side has a
 * test pinning it, so a level changed in one place without the others is caught.
 *
 * The deliberate choices, against §10.1:
 *
 *  * `open_app` / `open_settings` — L1: personal, low-risk, reversible.
 *  * `open_deep_link` — L2: an arbitrary URI leaves the app for content it did
 *    not choose, i.e. external communication.
 *  * `dial_number` — L2: §9.2 says "show number, confirm"; a call reaches
 *    someone outside the user's account.
 *  * `set_brightness` / `set_dnd` — L3: each changes a device-wide setting,
 *    which §10.1 rates sensitive/consequential ("change account setting" →
 *    explicit confirm).
 *  * media transport — L1: local and instantly reversible.
 *  * `start_recording` — L3: it opens the microphone and records the people in
 *    the room. §9.5 requires a visible recording indicator and a consent flow,
 *    and §15.4 requires recording to be off by default and explicit, so this is
 *    the one device action that must always be confirmed before it runs.
 *  * `stop_recording` — L1: ending a session that is already running changes
 *    nothing on the device, and making the user confirm *stopping* a recording
 *    is the wrong failure mode.
 *
 * Not present here, on purpose: Wi-Fi and Bluetooth toggles (Android 10/12 made
 * them impossible for third-party apps, so the app only deep-links to Settings),
 * SMS (deferred by §9.2) and screen reading (excluded from the consumer MVP).
 */
export const DEVICE_CONTROL_TOOL_LEVELS = {
	open_app: TOOL_LEVEL_PERSONAL_WRITE,
	open_deep_link: TOOL_LEVEL_EXTERNAL,
	open_settings: TOOL_LEVEL_PERSONAL_WRITE,
	dial_number: TOOL_LEVEL_EXTERNAL,
	set_brightness: TOOL_LEVEL_SENSITIVE,
	set_dnd: TOOL_LEVEL_SENSITIVE,
	media_play: TOOL_LEVEL_PERSONAL_WRITE,
	media_pause: TOOL_LEVEL_PERSONAL_WRITE,
	media_next: TOOL_LEVEL_PERSONAL_WRITE,
	media_previous: TOOL_LEVEL_PERSONAL_WRITE,
	start_recording: TOOL_LEVEL_SENSITIVE,
	stop_recording: TOOL_LEVEL_PERSONAL_WRITE,
} as const satisfies Record<string, ToolPermissionLevel>;

/** Every device-control action name, derived from the registry. */
export type DeviceControlActionName = keyof typeof DEVICE_CONTROL_TOOL_LEVELS;

export const DEVICE_CONTROL_ACTION_NAMES = Object.keys(
	DEVICE_CONTROL_TOOL_LEVELS,
) as DeviceControlActionName[];

/**
 * The level of a device-control action.
 *
 * An unknown name is L3 for the same reason [toolPermissionLevel] defaults that
 * way: the caller is untrusted, and a device action added on one side without
 * being classified on the other must not slip through as low-risk.
 */
export function deviceControlActionLevel(name: string): ToolPermissionLevel {
	return name in DEVICE_CONTROL_TOOL_LEVELS
		? DEVICE_CONTROL_TOOL_LEVELS[name as DeviceControlActionName]
		: TOOL_LEVEL_SENSITIVE;
}

/** True when a device-control action must be confirmed before it runs. */
export function deviceControlRequiresConfirmation(
	name: string,
	threshold: ToolPermissionLevel = toolConfirmationLevel(),
): boolean {
	return deviceControlActionLevel(name) >= threshold;
}

// ─── Tool definitions ────────────────────────────────────────────────

const CREATE_REMINDER_DESCRIPTION = [
	'Create a reminder that will notify the user at a specific date and time.',
	'Use this whenever the user asks to be reminded of something ("remind me to call the bank tomorrow at 5pm").',
	'`trigger_at` must be an ISO 8601 date-time. Include the UTC offset when you know it',
	'(2026-09-19T17:00:00+05:30); if you send a wall-clock time with no offset it is interpreted in the user timezone.',
	'It must be in the future — a past time is rejected.',
	'When they asked for something that repeats, send `repeat_rule` too, and treat `trigger_at` as the first time it goes off.',
].join(' ');

const CREATE_TASK_DESCRIPTION = [
	'Add a task to the user\'s task list.',
	'Use this when the user asks to add, note down or keep track of something to do but gives no specific time to be alerted',
	'("add a task to send the invoice"). If they give a deadline, put it in `due_at` as an ISO 8601 date-time.',
	'When they name a day but no time ("due tomorrow"), do not choose an hour for them: leave `due_at` out,',
	'send a date on its own, or ask them what time they mean in one short question. An hour they did not give is refused.',
].join(' ');

const SAVE_MEMORY_DESCRIPTION = [
	'Save a durable fact, preference, event, contact or decision about the user so you remember it later.',
	'Use this when the user tells you something about themselves they would expect you to recall ("I prefer morning meetings").',
	'Use it for a correction too, with the new fact stated in full ("actually my favourite colour is green"):',
	'an earlier memory that states the same thing differently is superseded automatically, so only one version is ever live.',
	'Saying you have updated a memory without calling this tool leaves both versions in place, which is a false statement about their data.',
].join(' ');

const FORGET_MEMORY_DESCRIPTION = [
	'Forget something the user previously asked you to remember.',
	'Use this when they ask you to forget, drop or delete a memory ("forget my favourite colour", "you can forget about the Algarve trip").',
	'Pass the fact in their own words — saved memories are matched by their content, because the list you were given does not show a memory id.',
	'It archives the matching memory so it stops appearing in what you know about them; the row is kept, not destroyed.',
	'If the result says nothing matched, say you had nothing saved about that. Never claim a memory is gone unless this tool reported it.',
].join(' ');

/**
 * Shared by every tool that acts on a row the user already has.
 *
 * The id is the security boundary as well as the addressing scheme: the
 * executor scopes the lookup by the authenticated user, so an id belonging to
 * somebody else fails exactly like an id that does not exist. Telling the model
 * to take ids from the grounding block — rather than to guess one — is what
 * makes "that one" resolvable without ever letting it reach a foreign row.
 */
const TARGET_ID_RULE =
	'Take this from the id shown beside the item in the list of their reminders and tasks you were given. ' +
	'Never invent an id or guess one: an id that is not that list, or that belongs to somebody else, fails. ' +
	'If you cannot tell which item they mean, ask them which one instead of guessing.';

/**
 * The `repeat_rule` property, shared by the two reminder tools that can set one.
 *
 * Shared rather than written twice because the grammar is the contract: a model
 * offered two subtly different descriptions of the same field will eventually send
 * a rule one of them does not describe. The forms named here are exactly the ones
 * `REPEAT_RULE_FORMS` in `./reminder-recurrence.js` accepts, and the ones the
 * phone can repeat with the app closed — `flutter_local_notifications` has no
 * interval component, so "every other week" is refused rather than stored and
 * silently fired weekly.
 */
const REPEAT_RULE_DESCRIPTION = [
	'How the reminder repeats, when the user asked for a repeat. Exactly one of three forms:',
	'"FREQ=DAILY" (every day), "FREQ=WEEKLY;BYDAY=MO" (every week on one weekday, from',
	'MO, TU, WE, TH, FR, SA and SU), or "FREQ=MONTHLY;BYMONTHDAY=15" (every month on that',
	'day of the month). Omit it for a reminder that goes off once, which is the ordinary case.',
	'`trigger_at` is then the first time it goes off, not a limit.',
	'A monthly day of 29, 30 or 31 does not go off in a month that has no such day.',
	'"Every other week", "every 3 days" and "the last Friday" are not expressible here — the',
	'phone can repeat daily, weekly on a weekday or monthly on a day, and nothing else — so say',
	'that rather than inventing a rule.',
].join(' ');

const UPDATE_REMINDER_DESCRIPTION = [
	'Change a reminder the user already has — move it to a different date and time, or rename it.',
	'Use this for "push that back to Friday", "make it 6pm instead" or "call it something else", and for every',
	'relative request — "remind me in an hour", "snooze it by 30 minutes", "not now, remind me after lunch" —',
	'by sending `in_minutes` (the offset in minutes) instead of `trigger_at`.',
	'Give `trigger_at`, `in_minutes`, `title`, or a combination; anything you omit is left as it was.',
	'Set `repeat_rule` to make it repeat, or send it as null to stop a reminder that already repeats.',
	'`in_minutes` is measured from the current time in your instructions, so a snooze never depends on their guess at the clock.',
	'To stop a reminder entirely use cancel_reminder, and to add a new one use create_reminder.',
].join(' ');

const CANCEL_REMINDER_DESCRIPTION = [
	'Cancel a reminder so it stops notifying the user and no longer appears as something coming up.',
	'The reminder is kept, not destroyed, so it can be restored from the reminders screen — ' +
	'which is what makes cancelling the safe answer when they say "forget about that" or "never mind".',
].join(' ');

const COMPLETE_TASK_DESCRIPTION = [
	'Mark one of the user\'s tasks as done.',
	'Call this only when the user says the work is actually finished ("I sent the invoice", "tick off the proposal").',
	'Do not call it to be encouraging: the tool is the only thing that changes the task, so a claim that a task is ' +
	'done without this call succeeding is a false statement about their data. If it fails, say so.',
].join(' ');

const REOPEN_TASK_DESCRIPTION = [
	'Bring a completed or cancelled task back to the user\'s open list.',
	'Use this when they say something was not actually finished ("actually I still need to do the proposal").',
].join(' ');

/**
 * The user's answer to a follow-up NOVA raised on its own initiative (§18).
 *
 * This exists because "do not nag" is only half a feature: without a way for the
 * user to say *stop*, the follow-up engine has no way to learn that its question was
 * answered, and the next sweep would keep the item alive. `leave` records "leave it
 * as is" and `snooze` records "remind me later", and the engine reads both back
 * before it speaks again.
 *
 * It is separate from `cancel_reminder` / `complete_task` on purpose. Neither of
 * those expresses "stop asking me about this but do not change it", which is exactly
 * the third option the follow-up offers and, from experience, the answer a user gives
 * most often.
 */
const RESOLVE_FOLLOW_UP_DESCRIPTION = [
	'Record the user\'s answer to a follow-up NOVA raised about one of their unfinished items.',
	'Call this when they answer it — "leave it", "leave it as it is", "not now", "remind me later", "ask me tomorrow".',
	'Use `leave` when they want it left alone, and `snooze` when they want to be asked again later; pass ' +
	'`snooze_minutes` only when they named a delay ("in an hour" is 60).',
	'This does not complete, cancel, reschedule or edit the item — it only records that they have answered, so ' +
	'NOVA stops asking. If they actually want the thing finished, cancelled or moved, call the tool for that instead.',
].join(' ');

export const ASSISTANT_TOOLS: ToolDefinition[] = [
	{
		name: 'create_reminder',
		description: CREATE_REMINDER_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'Short reminder text, e.g. "Call the bank". Always in the user\'s language.',
				},
				trigger_at: {
					type: 'string',
					description:
						'When to notify, ISO 8601, e.g. "2026-09-19T17:00:00+05:30". A value with no offset is read in the user timezone. Must be in the future. ' +
						'If the user gave a day but no time, do not choose an hour for them: send the date on its own, or ask them what time they mean. ' +
						'A clock time the user did not give is refused.',
				},
				timezone: {
					type: 'string',
					description: 'Optional IANA timezone for the reminder, e.g. "Asia/Kolkata". Defaults to the user timezone.',
				},
				repeat_rule: {
					type: 'string',
					maxLength: 120,
					description: REPEAT_RULE_DESCRIPTION,
				},
			},
			required: ['title', 'trigger_at'],
			additionalProperties: false,
		},
	},
	{
		name: 'update_reminder',
		description: UPDATE_REMINDER_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				reminder_id: {
					type: 'string',
					description: `The id of the reminder to change. ${TARGET_ID_RULE}`,
				},
				title: {
					type: 'string',
					description: 'New reminder text. Omit to leave the current title unchanged.',
				},
				trigger_at: {
					type: 'string',
					description:
						'New time to notify, ISO 8601, e.g. "2026-09-19T17:00:00+05:30". A value with no offset is read in the ' +
						'user timezone. Omit to leave the current time unchanged. If they gave a day but no time, do not choose ' +
						'an hour for them: ask what time they mean, and send `trigger_at` only once they have named one.',
				},
				in_minutes: {
					type: 'integer',
					minimum: 1,
					// Mirrors the zod bound in `assistant-tool-executor.ts`,
					// which follows the follow-up snooze ceiling: a week.
					maximum: 10080,
					description:
						'Move the reminder this many minutes from now, for a relative request — "in an hour" is 60, ' +
						'"snooze it by 30 minutes" is 30, "not now, remind me after lunch" is however many minutes that is ' +
						'from the current time given in your instructions. The server adds it to its own clock, so do not ' +
						'convert it to a date yourself. Send either this or `trigger_at`, never both.',
				},
				repeat_rule: {
					// Nullable, because "stop repeating this" is a change the user can
					// ask for and there is no other field that could express it.
					type: ['string', 'null'],
					maxLength: 120,
					description: `${REPEAT_RULE_DESCRIPTION} Send null to stop a reminder that already repeats.`,
				},
			},
			required: ['reminder_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'cancel_reminder',
		description: CANCEL_REMINDER_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				reminder_id: {
					type: 'string',
					description: `The id of the reminder to cancel. ${TARGET_ID_RULE}`,
				},
			},
			required: ['reminder_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'create_task',
		description: CREATE_TASK_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short task text, e.g. "Send the invoice".' },
				due_at: {
					type: 'string',
					description:
						'Optional deadline, ISO 8601, e.g. "2026-09-19T17:00:00+05:30". A value with no offset is read in the user timezone. ' +
						'If the user gave a day but no time, do not choose an hour for them: leave this out, send a date on its own, ' +
						'or ask them what time they mean.',
				},
			},
			required: ['title'],
			additionalProperties: false,
		},
	},
	{
		name: 'complete_task',
		description: COMPLETE_TASK_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				task_id: {
					type: 'string',
					description: `The id of the task that is finished. ${TARGET_ID_RULE}`,
				},
			},
			required: ['task_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'reopen_task',
		description: REOPEN_TASK_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				task_id: {
					type: 'string',
					description: `The id of the task to bring back. ${TARGET_ID_RULE}`,
				},
			},
			required: ['task_id'],
			additionalProperties: false,
		},
	},
	{
		name: 'save_memory',
		description: SAVE_MEMORY_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description: 'The fact to remember, written as a short standalone statement, e.g. "Prefers morning meetings".',
				},
				category: {
					type: 'string',
					enum: ['fact', 'preference', 'event', 'contact', 'decision'],
					description: 'What kind of thing this is. Use "preference" for likes and dislikes.',
				},
			},
			required: ['content', 'category'],
			additionalProperties: false,
		},
	},
	{
		name: 'forget_memory',
		description: FORGET_MEMORY_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description:
						'The fact to forget, in the user\'s own words or a short phrase naming it, e.g. "my favourite colour" or ' +
						'"the Algarve trip". It is matched against what you have saved about them, so use the wording of the fact itself.',
				},
			},
			required: ['content'],
			additionalProperties: false,
		},
	},
	{
		name: 'resolve_follow_up',
		description: RESOLVE_FOLLOW_UP_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				item_type: {
					type: 'string',
					enum: ['task', 'reminder'],
					description: 'Whether the follow-up was about a task or a reminder.',
				},
				item_id: {
					type: 'string',
					description: `The id of the item the follow-up was about. ${TARGET_ID_RULE}`,
				},
				decision: {
					type: 'string',
					enum: ['leave', 'snooze'],
					description: '"leave" to stop asking about it, "snooze" to be asked again later.',
				},
				snooze_minutes: {
					type: 'integer',
					minimum: 5,
					maximum: 10080,
					description:
						'How long to wait before asking again, in minutes. Only for "snooze"; omit it and NOVA waits a day.',
				},
			},
			required: ['item_type', 'item_id', 'decision'],
			additionalProperties: false,
		},
	},
];

// ─── Bounded tool loop ───────────────────────────────────────────────

/**
 * Hard ceiling on model calls per user turn. A model that answers directly
 * uses one; the ordinary "call a tool, then confirm" turn uses two; a turn that
 * chains two rounds of tools uses three. Beyond that we stop calling the model
 * and return the last text we have, so a looping model cannot spend unbounded
 * tokens or take unbounded time.
 */
export const MAX_TOOL_ITERATIONS = 3;

// ─── Grounding: the reply is the outcome, not the narration ──────────

/**
 * Prose that reads as a claim that the user's data has already changed.
 *
 * This is the guard against the defect measured on a real device:
 *
 *   USER:  "Actually reopen it."
 *   NOVA:  "Done! I've reopened the task to prepare the client proposal."
 *   log:   iterations:1  tools:[]            ← no tool ran at all
 *   db:    status still 'completed'
 *
 * and its sibling, where an acknowledgement of the user's own report —
 * "That's great! One down! 🎉" — was accepted as a completion while both rows
 * stayed `pending`. The model's text is a claim; a tool result is a fact. When
 * a turn claims a change and no tool ran, the claim cannot be true.
 *
 * It is deliberately a *heuristic over wording*, not a parser, and it is biased
 * towards matching: a false positive costs one corrective model call and, at
 * worst, replaces a plausible sentence with a true one, while a false negative
 * puts a lie about the user's own list in front of them. Only one direction is
 * recoverable.
 */
const STATE_CHANGE_CLAIM_PATTERNS: RegExp[] = [
	// "Done!", "All done.", "Done — the reminder is set."
	/\b(?:all\s+)?done\b\s*[!.,:;—–-]/i,
	/\bthat'?s\s+(?:it|done|sorted|taken\s+care\s+of)\b/i,
	// "That's great! One down!" — the measured false completion.
	/\b(?:one|two|three|\d+)\s+down\b/i,
	// "I've reopened…", "I have just completed…", "I already saved…"
	/\bI(?:'ve|’ve| have| just| already)\s+(?:\w+\s+){0,2}(?:re-?opened|opened|set|added|created|saved|marked|completed|finished|updated|changed|cancelled|canceled|moved|rescheduled|reminded|noted|recorded|ticked|snoozed|postponed|delayed|forgotten|forgot|deleted|erased|removed)\b/i,
	// Simple past: "I reopened it", "I added that task", "I deleted that memory".
	/\bI\s+(?:re-?opened|set|added|created|saved|marked|completed|finished|updated|cancelled|canceled|moved|rescheduled|ticked|snoozed|postponed|delayed|forgot|deleted|erased|removed)\b/i,
	// Passive or state: "the task is reopened", "your reminder has been cancelled",
	// "that memory is archived".
	/\b(?:task|reminder|item|memory|note|it|that)\b[^.?!]{0,40}?\b(?:is|are|has\s+been|have\s+been|'s\s+been)\s+(?:now\s+)?(?:re-?opened|opened|set|added|created|saved|marked|completed|finished|updated|cancelled|canceled|moved|rescheduled|dismissed|ticked|snoozed|postponed|delayed|forgotten|deleted|erased|removed|archived)\b/i,
	// "I deleted the memory…", "I've forgotten that.", "you can forget about it".
	/\b(?:forgotten|forgot|deleted|erased|removed|archived)\s+(?:that|it|this|those|them|the\s+(?:memory|memories|fact|facts|note))\b/i,
	// "That memory is no longer saved.", "it is no longer remembered".
	/\bno\s+longer\s+(?:saved|remembered|stored|in\s+(?:your\s+)?memory)\b/i,
	/\bmarked\s+(?:it|that|them|the\s+\w+)\s+as\s+(?:complete|completed|done)\b/i,
	/\bticked\s+(?:it|that|them|the\s+\w+)?\s*off\b/i,
	/\bsaved\s+(?:that|it|this)\s+to\s+(?:your\s+)?memory\b/i,
	/\badded\s+(?:that|it|this)\s+to\s+your\s+(?:task\s+list|tasks|to-?dos?|list)\b/i,
	/\breminder\s+(?:is\s+|has\s+been\s+)?(?:set|created|scheduled|cancelled|canceled)\b/i,
	/\bnoted\b\s*[!.]/i,

	// ── Tamil and Tanglish ──────────────────────────────────────────────
	// Every pattern above is English, and the guard therefore could not see the
	// claim NOVA actually made to a Tamil user. Measured on the live voice route:
	// asked in Tanglish to set a reminder, the model answered *"நாளைக்கு காலை
	// client-க்கு call பண்ண remind set பண்ணிட்டேன்"* — "I have set the reminder" —
	// while `tools: []` and the reminder list was unchanged. The English guard saw
	// nothing, the reply went out verbatim, and the user was told an action had
	// happened that had not. That is the same P0-4 defect the English patterns
	// exist to prevent, unfixed on the language NOVA is built for.
	//
	// The signal is the Tamil **completed aspect**, which is a suffix rather than
	// a word: `-ிட்டேன்` / `-ட்டேன்` / `-ுட்டேன்` ("I did it, and it is done"). The
	// vowel is written as an alternation rather than a character class —
	// `[ிட்ட]`-style classes are what ESLint's `no-misleading-character-class`
	// flags, and it is right to: a combining vowel sign cannot stand alone, so a
	// class containing one reads as "either this letter or that mark", which is
	// not what the class means here. It is deliberately narrow. A present-tense
	// statement about state — "நாளைக்கு reminder இருக்கு", "there is a reminder
	// tomorrow" — must NOT match, because replacing a true description with
	// "nothing has been changed" would be the guard lying in the other direction.
	// `இருக்கு` (is) and the other copulas are therefore absent.
	/(?:ி|ு)ட்டேன்|(?:ி|ு)ட்டே(?![\u0B80-\u0BFF])|(?:ஆ|ா)யிடுச்சு|(?:ஆ|ா)ச்சு|விட்டது|முடிஞ்சுடுச்சு|முடிந்தது/,
	// The same completed aspect carried on the "-ச்சு / -ட்டு / -ஞ்சு" stems,
	// which is how "set it" and "did it" are actually spoken: வெச்சுடுச்சு
	// ("I've put it down"), செஞ்சுடுச்சு ("I've done it"), சேர்த்துடுச்சு ("I've
	// added it"), வச்சுட்டேன் ("I've kept it"). Measured on a real handset on
	// 2026-09-22: asked in Tanglish to set a reminder, the model called no tool
	// and answered "…ரிமைண்டர் வெச்சுடுச்சு" — "the reminder is set" — and the
	// guard read it as no claim at all, because every alternative above needs a
	// different suffix, so the false confirmation went out verbatim and the
	// reminder list was unchanged. The stems are listed rather than the suffixes
	// alone so that a present-tense statement about state, which has no
	// completive stem, still does not match.
	/(?:ச்சு|ட்டு|ஞ்சு|த்து|ந்து|ண்டு)(?:டுச்சு|ட்டேன்|ட்டா)/,
	// The same in Latin script, which is how Tanglish is typed.
	/\b(?:vech(?:u|i)?d?uch(?:u|a)?|vaich(?:u)?d?uch(?:u|a)?|senj(?:u)?d?uch(?:u|a)?|serth(?:u)?d?uch(?:u|a)?|pann(?:i)?yach(?:u)?|maath(?:i)?yach(?:u)?)\b/i,
	// The same completed aspect written in Latin script, which is how Tanglish is
	// actually typed and how the STT returns it most of the time.
	/\b(?:pann?i(?:tt|t)(?:en|an|om|aan|een)|pannitten|panniten|pannitaen|maath?i(?:tt|t)(?:en|an|een)|maathiten|vech(?:i)?rukk?(?:en|an)|aayid(?:u)?ch(?:u|i)|aayiduchu|mudinjuduchu|mudinjiduchu|mudinjiruchu)\b/i,
	// "set ஆயிடுச்சு", "add பண்ணிட்டேன்" — a borrowed English verb carrying the
	// Tamil completion marker, which is the most common shape of all.
	/\b(?:set|add|added|save|saved|delete|deleted|remove|removed|create|created|cancel|cancelled|canceled|update|updated|move|moved|complete|completed|finish|finished|mark|marked|remind|reminded|note|noted|snooze|snoozed)\b[^.?!\n]{0,24}(?:ிட்டேன்|ிட்டே|ாயிடுச்சு|ஆயிடுச்சு|pann?itten|pann?iten|pann?iyachu|aayiduchu)/i,
];

/** True when [text] asserts that something was already created, changed or done. */
export function claimsStateChange(text: string): boolean {
	if (!text) return false;
	return STATE_CHANGE_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The one corrective turn sent back when the model narrated an action it never
 * took. Server-authored, and phrased as the user's own turn because that is the
 * only place a host instruction is honoured — the tool contract already
 * required this, and the model ignored it, so it is restated as an explicit
 * contradiction of what it just said.
 */
export const UNBACKED_CLAIM_CORRECTION =
	'You replied as though you had already changed something, but you called no tool, so nothing was changed. ' +
	'If the user asked you to do something, call the matching tool now and answer from its result. ' +
	'If you cannot tell which item they mean, say plainly that nothing has been changed and ask them which one.';

/**
 * The **second** corrective turn, sent only after the first one was answered
 * with prose rather than a tool call.
 *
 * `UNBACKED_CLAIM_CORRECTION` above ends with *"ask them which one"*, and on the
 * live spoken route that is what the model did: measured on the Tanglish create
 * path, the user asked for a reminder, the model claimed one with `tools: []`,
 * the first correction was sent, and the second answer was another sentence with
 * no tool call — so the turn ended with the honesty floor and **the reminder was
 * never set**. The floor is true and it is still a failure: every word of "no
 * action was carried out" is correct, and the user who asked for the reminder
 * did not get it. The instruction was the problem, not the guard. Asking "which
 * one" is right when the target genuinely cannot be resolved; it is wrong when
 * the user already gave everything the tool needs, because it turns a turn the
 * model could have finished into a question the user has to answer.
 *
 * So this one names the preference explicitly and in that order: act first with
 * what they gave, and ask only about a field that is genuinely unresolvable (a
 * required id for "the other one" with two candidates, an hour they never named
 * when the tool refuses an invented one). It deliberately does **not** say
 * "never ask" — asking is the correct answer to a real ambiguity, and this file's
 * executor refuses an invented id rather than guessing one, so a model pushed to
 * call a tool at any cost produces a refused call, not a wrong row.
 *
 * It is a user-role turn like the first: that is the only place a host
 * instruction has been observed to be honoured, and it reads as the continuation
 * of the same contradiction rather than as new system policy.
 */
export const UNBACKED_CLAIM_ACTION_CORRECTION =
	'You still called no tool, so nothing has been changed. ' +
	'Call the matching tool now, with the details the user already gave you — do not ask again for ' +
	'something they already told you, and do not describe what you are about to do. ' +
	'Ask one short question only if a required field genuinely cannot be resolved from what they said; ' +
	'otherwise call the tool and answer from its result.';

/**
 * True when the user's own turn asked NOVA to **change** something — create,
 * move, cancel, complete, remember or forget one of their things.
 *
 * This is the write half of the signal, and it is a deliberately plain regex
 * over their wording rather than a call to the model: it must be free, it must
 * be the same answer every time it is asked about the same turn, and a
 * misclassification costs one bounded re-prompt rather than anything the user
 * sees. `claimsStateChange` is the read half — a turn that claims a change.
 *
 * It is biased towards matching, for the same asymmetry the claim detector
 * documents: a false positive spends one model call and, at worst, asks the
 * model to act on a turn that was really a question — and the second correction
 * still leaves "I cannot resolve this field" as an allowed answer, so the
 * fallback is a question rather than an invention. A false negative leaves the
 * turn where it is today. Only one of those is recoverable.
 *
 * Not matched on purpose: "do you remember my birthday?" (a question about what
 * is already saved), "I finished the proposal" with no request attached, and
 * anything with no action verb at all. Those are read or already-done turns, and
 * re-prompting them is exactly the "which one do you mean?" regression this
 * guard must not cause.
 */
const WRITE_INTENT_PATTERNS: RegExp[] = [
	// "remind me to call the bank", "remind me in an hour", "remind me about it"
	/\bremind\s+me\b/i,
	// "add a task", "add that to my list", "note down the invoice number"
	/\b(?:add|create|make|set\s+up|put|save|note\s+down|write\s+down|jot\s+down|log)\b[^.?!\n]{0,40}\b(?:task|reminder|to-?do|note|list|memory)\b/i,
	/\b(?:task|reminder|to-?do)\b[^.?!\n]{0,40}\b(?:add|create|make|set\s+up)\b/i,
	// "don't forget to…", "don't let me forget…"
	/\b(?:don'?t|do\s+not)\s+(?:forget|let\s+me\s+forget)\b/i,
	// "remember that I prefer morning meetings", "remember to send the invoice"
	/\bremember\s+(?:that|to)\b/i,
	// "forget about the Algarve trip", "forget my favourite colour"
	/\bforget\s+(?:about\s+)?(?:my|the|that|this|it|what)\b/i,
	// "cancel that reminder", "cancel it"
	/\bcancel\s+(?:it|that|this|them|those|my|the)\b/i,
	// "mark it as done", "tick off the proposal", "complete the proposal task"
	/\b(?:mark|tick)\b[^.?!\n]{0,20}\b(?:done|complete|completed|off)\b/i,
	/\bcomplete\s+(?:the|my|that|this|it|them)\b/i,
	// "snooze it by 30 minutes", "push that back to Friday", "move it to 6pm",
	// "push the plumber reminder to Friday" — the item may be named between the
	// verb and the reference, so the gap is bounded rather than literal.
	/\b(?:snooze|reschedule|push|move)\b[^.?!\n]{0,30}\b(?:reminder|task|it|that|this)\b/i,
	// "reopen it", "bring the task back"
	/\b(?:re-?open|bring\s+back)\b[^.?!\n]{0,20}\b(?:it|that|this|task)\b/i,
	// The polite request, where the verb alone is too weak to read as an ask.
	/\b(?:can|could|would|will)\s+you\b[^.?!\n]{0,40}\b(?:add|create|make|set|remind|remember|forget|cancel|complete|re-?open|move|snooze|save|note)\b/i,
];

/** True when the user's turn asked NOVA to change something of theirs. */
export function asksForWrite(text: string | undefined): boolean {
	if (!text) return false;
	return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when the reply is a question put back to the user rather than an answer.
 *
 * This is what keeps "the model could not act" apart from "the model asked the
 * one thing it could not resolve", which is a legitimate outcome and must not be
 * chased: the negative case in the tests is *"which one do you mean?"* over two
 * candidate tasks, and re-prompting that into an action is how a wrong row gets
 * written. A question mark at the end of the trimmed reply is the cheap, stable
 * test; a claim of a completed change is never a question, whatever punctuation
 * it ends with, so the claim is excluded first.
 */
export function asksUserBack(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (claimsStateChange(trimmed)) return false;
	return /\?["'”’)\]]?\s*$/.test(trimmed);
}

/**
 * What the user is told when the model claimed an action and no tool ran — the
 * floor under the correction above, for a model that will not call the tool.
 * True, short enough to be spoken, and it does not pretend to know the item.
 */
export const NOTHING_PERFORMED_REPLY =
	"I haven't changed anything yet — no action was carried out. Tell me what you'd like me to do and I'll do it.";

/**
 * The same floor, in the language the user is actually speaking.
 *
 * The guard fires precisely when the model has misbehaved, and the model
 * misbehaves most on the languages it is weakest in — so the *English-only* floor
 * landed on exactly the users least able to read it. Measured on the live spoken
 * route: a Tanglish reminder request where the model claimed an action with no
 * tool call was answered, after one re-prompt, with the English sentence above.
 * The user had spoken Tamil throughout.
 *
 * Only the languages whose wording has been checked by hand are listed; anything
 * else falls back to English rather than to a machine guess at a sentence the
 * user will hear spoken aloud. Adding a language here is a deliberate act.
 */
const NOTHING_PERFORMED_BY_LANGUAGE: Record<string, string> = {
	ta: 'நான் இன்னும் எதையும் மாற்றவில்லை — எந்தச் செயலையும் செய்யவில்லை. என்ன செய்யணும்னு சொல்லுங்க, நான் செய்கிறேன்.',
	tanglish:
		'Naan innum edhayum maathavillai — endha action-um nadakkavillai. Enna pannanum-nu sollunga, naan panren.',
};

/** The floor reply for [language], or the English one when it is not listed. */
export function nothingPerformedReply(language?: string): string {
	if (!language) return NOTHING_PERFORMED_REPLY;
	// `ta-IN`, `ta_IN` and `ta` all name Tamil.
	const base = language.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
	return (
		NOTHING_PERFORMED_BY_LANGUAGE[language.trim().toLowerCase()] ??
		NOTHING_PERFORMED_BY_LANGUAGE[base] ??
		NOTHING_PERFORMED_REPLY
	);
}

/**
 * The text the user actually sees, given the model's last prose and the tools
 * that really ran. One place decides this, so the no-tool, failed-tool and
 * succeeded-tool cases cannot drift apart.
 *
 *  * No tool ran and the text claims a change → the claim is replaced.
 *  * A tool ran and failed while the text reads as success → the model is not
 *    believed; the executor's own account of each call is used instead.
 *  * Everything succeeded → the model's reply stands, untouched, because it is
 *    now describing something that actually happened.
 */
export function groundAssistantReply(
	modelText: string,
	calls: ExecutedToolCall[],
	language?: string,
): { text: string; corrected: boolean } {
	if (!calls.length) {
		return claimsStateChange(modelText)
			? { text: nothingPerformedReply(language), corrected: true }
			: { text: modelText, corrected: false };
	}

	const failed = calls.filter((call) => !call.ok);
	if (failed.length && claimsStateChange(modelText)) {
		return { text: toolSummaryText(calls), corrected: true };
	}

	return { text: modelText, corrected: false };
}

export interface AssistantToolLoopResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	toolCalls: ExecutedToolCall[];
	/** Model calls actually made (1..MAX_TOOL_ITERATIONS). */
	iterations: number;
	/** True when the cap stopped the loop before the model finished. */
	capped: boolean;
	/**
	 * True when the model's own text claimed a change it had not made (or made
	 * and failed) and the reply was replaced with the truth. Always false for a
	 * turn whose text was the model's own, honest wording.
	 */
	claimCorrected?: boolean;
	/**
	 * True when the user's turn asked for a change to their own data and the turn
	 * ended with no **successful** tool call behind it — the action half of the
	 * same defect `claimCorrected` covers the honesty half of. Logged at the end
	 * of every such turn with the model id, so a future model change that makes
	 * it worse is visible as a rate rather than as an anecdote.
	 *
	 * It is deliberately **not** set for a turn whose reply was a question put
	 * back to the user. "Which one do you mean?" over two candidate tasks is the
	 * correct answer to an unresolvable reference, and counting it here would
	 * make a healthy clarification look like a failure and invite a future
	 * "fix" that pushes the model to guess. `askedUserBack` below records that
	 * turn separately, so the two rates stay distinguishable.
	 *
	 * Undefined (rather than false) when nothing could be unfulfilled: a
	 * successful write, a turn the user did not ask to change anything on, or a
	 * cap return.
	 */
	writeIntentUnfulfilled?: boolean;
	/**
	 * True when the reply the user is left with is a question rather than an
	 * outcome — the signal that makes the metric above honest about what it is
	 * not counting. Recorded on every turn that ended without a tool call, so a
	 * shift from "acted" to "asked" is visible in the aggregate even though it is
	 * not a failure.
	 */
	askedUserBack?: boolean;
	/** Which provider served the turn's last model call. */
	provider?: string;
	/** True when the configured secondary provider served any part of the turn. */
	fellBack?: boolean;
}

export interface AssistantToolLoopOptions {
	systemPrompt: string;
	maxTokens?: number;
	temperature?: number;
	/**
	 * Model override for this turn.
	 *
	 * The spoken route passes the voice model here. It is an explicit option
	 * rather than a second `chatCompletion` default because this loop serves both
	 * the spoken and the typed surface, and the two want different models for a
	 * measured reason: on six representative spoken prompts GLM-5.3 answered in
	 * 15–131 s (mean 61 s, one an outright 502 because its reasoning consumed the
	 * whole output budget) while claude-haiku-4-5 answered the same six in 3.7 s
	 * mean. Latency *is* the product on a spoken turn and is nearly free on a
	 * typed one, so the typed path keeps the stronger model and the spoken path
	 * takes the faster one.
	 */
	model?: string;
	/**
	 * The language the user is speaking, so the one reply the server authors
	 * itself can be written in it.
	 *
	 * `groundAssistantReply` replaces an unbacked claim with a sentence of our
	 * own, and that sentence used to be English whatever the user spoke —
	 * measured on the live route answering a Tanglish turn. Optional: callers
	 * that do not know it get the English floor, which is the previous
	 * behaviour.
	 */
	language?: string;
}
/**
 * The user's own words for this turn — the last thing they said.
 *
 * The loop's own `tool_result` turns are also `role: 'user'`, and they carry no
 * prose, so they are skipped: a guard asked "did the user state a clock time?"
 * against a block of JSON would answer "no" for every turn after the first and
 * refuse a time the user really did give. A message with only text blocks counts
 * the same as a plain string; anything with no text at all is passed over.
 *
 * Exported because the **streaming** loop needs the same answer. It is the primary
 * voice path, and it had its own copy of "which message is the user's turn" would
 * have been a second definition to drift — the same mistake that let the honesty
 * guard exist on one path and not the other.
 */
export function userTurnText(messages: ChatMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'user') continue;
		const text =
			typeof message.content === 'string'
				? message.content
				: message.content
						.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
						.map((block) => block.text)
						.join(' ');
		if (text.trim()) return text;
	}
	return undefined;
}

/**
 * Runs the model, executes any tools it asks for, feeds the results back, and
 * repeats until it produces a final text answer — or until the cap is reached.
 *
 * What comes back is the *outcome*, not the model's account of one. The text is
 * checked against the tools that actually ran (`groundAssistantReply`), so a
 * claim of a change that no tool made is replaced rather than forwarded, and a
 * failed write can never be dressed up as a success. On the cap the model has
 * not yet seen the last results, so its narration cannot be an outcome either
 * and the executor's own summary is returned.
 *
 * `userId` is the authenticated user. It is passed straight to the executor and
 * is never derived from anything the model sent.
 */
export async function runAssistantToolLoop(
	userId: string,
	messages: ChatMessage[],
	options: AssistantToolLoopOptions,
): Promise<AssistantToolLoopResult> {
	// Copy: the caller's history array must not be mutated with tool traffic.
	const conversation: ChatMessage[] = [...messages];
	const toolCalls: ExecutedToolCall[] = [];

	/**
	 * The turn the tools have to be licensed by, captured once before the loop
	 * mutates `conversation` with its own `tool_result` turns.
	 *
	 * Passed to every execution below so the executor can refuse a clock time the
	 * user never stated. `undefined` — a caller whose history has no user text —
	 * means "cannot check", which is the behaviour a caller had before this
	 * existed.
	 */
	const userTurn = userTurnText(messages);

	let lastText = '';
	let model = '';
	let usage = { inputTokens: 0, outputTokens: 0 };
	/** Which provider answered, and whether it was the secondary one. */
	let provider: string | undefined;
	let fellBack = false;
	/** The corrective turn is sent at most once, whatever the model answers. */
	let reprompted = false;
	/**
	 * The second, narrower corrective turn is likewise sent at most once. It is
	 * what turns "the model gave up" into "the tool ran": see
	 * [UNBACKED_CLAIM_ACTION_CORRECTION]. Bounded by construction — the loop runs
	 * at most `MAX_TOOL_ITERATIONS` calls, so with the first correction this can
	 * add **one** model call to a turn that would previously have ended at two.
	 */
	let actionReprompted = false;
	/**
	 * What the user asked for, read once from their own turn before the loop
	 * mutates the conversation. `undefined` when their history carries no user
	 * text, which reads as "no write was asked for" and leaves the turn exactly
	 * as it was.
	 */
	const writeAsked = asksForWrite(userTurn);
	/**
	 * ── Sticky provider selection, scoped to this turn ──────────────────
	 * The moment one call of this turn is served by the fallback, every later
	 * call of the *same turn* goes straight to the fallback. Without it, an
	 * iteration after a tool has run re-probes a primary this turn already knows
	 * is unusable, fails, and the turn reports failure even though its tool had
	 * its side effect — the measured defect, where the reminder was created and
	 * the user was told it was not.
	 *
	 * This is a local of the loop body, never module state: the next turn starts
	 * with `false` and probes the primary again, so a provider that recovers is
	 * used again and no other user is ever pinned to the fallback.
	 */
	let preferFallback = false;

	for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
		const completion = await chatCompletion(conversation, {
			systemPrompt: options.systemPrompt,
			model: options.model,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			tools: ASSISTANT_TOOLS,
			// ── Retry safety ─────────────────────────────────────────────
			// A provider failure may be retried on the secondary provider only
			// while this turn has executed nothing. Once `executeToolUses` below
			// has run, a retry could be misread as licence to repeat the turn —
			// and "remind me to call the bank" would create the reminder twice.
			// So the first model call of a turn may fall back and every call
			// after the first tool execution may not. See
			// `services/llm-fallback.ts#shouldUseFallback`.
			allowProviderFallback: toolCalls.length === 0,
			// ── Sticky selection ─────────────────────────────────────────
			// Not a retry: the provider for this turn was already chosen when its
			// first call fell back, so later iterations are simply sent to it.
			// This is what makes the guard above unnecessary mid-turn rather than
			// merely respected — the dead primary is never re-probed, so there is
			// nothing for it to refuse.
			preferFallback,
		});

		model = completion.model;
		provider = completion.provider ?? provider;
		if (completion.fellBack) {
			fellBack = true;
			// Remember the choice for the rest of *this* turn.
			preferFallback = true;
		}
		usage = {
			inputTokens: usage.inputTokens + completion.usage.inputTokens,
			outputTokens: usage.outputTokens + completion.usage.outputTokens,
		};
		if (completion.content.trim()) lastText = completion.content;

		if (!completion.toolUses.length) {
			// The turn ends here because the model stopped asking for tools. If it
			// wrote as though it had already acted, that text is not an outcome:
			// no tool ran, so nothing changed.
			if (toolCalls.length === 0 && claimsStateChange(lastText)) {
				// One corrective call first. It can still give the user what they
				// asked for — the model may simply have skipped the tool — and it
				// keeps the reply in the model's own voice. It is sent once, and
				// only while an iteration is left, which is what stops a model that
				// ignores the correction from looping on it.
				if (!reprompted && iteration < MAX_TOOL_ITERATIONS) {
					reprompted = true;
					logger.warn(
						{ userId, iteration },
						'Assistant claimed an action with no tool call — re-prompting once before answering',
					);
					conversation.push({ role: 'assistant', content: completion.blocks });
					conversation.push({ role: 'user', content: UNBACKED_CLAIM_CORRECTION });
					continue;
				}
			}

			// ── The second chance acts instead of asking ─────────────────
			// The corrective turn above ends with "ask them which one", and on the
			// live spoken route that is precisely what the model did: a reminder
			// request answered with a claim and `tools: []`, the correction sent,
			// and a second prose answer with no call — so the turn ended on the
			// honesty floor with the reminder never set. True, and still a turn the
			// user asked for something in and did not get it.
			//
			// This is the one and only extra call: sent when the user asked for a
			// write, the first correction has already been spent, nothing has
			// succeeded, and the reply is not a question back to the user. The last
			// condition is load-bearing — "which one do you mean?" over two
			// candidate tasks is the correct answer to an unresolvable reference,
			// and pushing a model past it is how a wrong row gets written.
			//
			// Bounded by the loop's own cap rather than by another counter:
			// `MAX_TOOL_ITERATIONS` is 3, and this branch can only be reached on an
			// iteration that is not the last, so the worst case for a whole turn is
			// three model calls — one more than the same turn costs today.
			if (
				writeAsked &&
				reprompted &&
				!actionReprompted &&
				iteration < MAX_TOOL_ITERATIONS &&
				!asksUserBack(lastText)
			) {
				actionReprompted = true;
				logger.warn(
					{ userId, iteration, model },
					'Assistant still called no tool after the correction — giving it one more turn to act',
				);
				conversation.push({ role: 'assistant', content: completion.blocks });
				conversation.push({ role: 'user', content: UNBACKED_CLAIM_ACTION_CORRECTION });
				continue;
			}

			const grounded = groundAssistantReply(lastText, toolCalls, options.language);
			if (grounded.corrected) {
				logger.warn(
					{ userId, iteration, tools: toolCalls.map((r) => `${r.name}:${r.ok ? 'ok' : 'failed'}`) },
					'Assistant reply was not backed by its tool results — replaced with the true outcome',
				);
			}
			const askedUserBack = asksUserBack(lastText);
			// "The user asked for a change and the turn ended without one." A
			// question put back to them is tracked separately rather than counted
			// here: it is a legitimate outcome, and conflating the two would make
			// this rate invite a future push to guess.
			const writeIntentUnfulfilled =
				writeAsked && !toolCalls.some((result) => result.ok) && !askedUserBack;
			if (writeIntentUnfulfilled) {
				logger.warn(
					{
						userId,
						model,
						iterations: iteration,
						askedUserBack,
						tools: toolCalls.map((r) => `${r.name}:${r.ok ? 'ok' : 'failed'}`),
					},
					'Assistant turn ended with the requested write unperformed',
				);
			}
			return {
				content: grounded.text,
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: false,
				claimCorrected: grounded.corrected,
				writeIntentUnfulfilled: writeIntentUnfulfilled || undefined,
				askedUserBack: askedUserBack || undefined,
				provider,
				fellBack,
			};
		}

		const results = await executeToolUses(userId, completion.toolUses, { userTurn });
		toolCalls.push(...results);

		if (iteration === MAX_TOOL_ITERATIONS) {
			logger.warn(
				{ userId, iteration, tools: results.map((r) => r.name) },
				'Assistant tool loop hit its iteration cap — returning the tool results, not the narration',
			);
			// The model is still mid-action and has never seen these results, so
			// whatever it said alongside the call is a narration of an intention.
			// The executor's own account of what happened is the only outcome
			// available, and it names failures as failures.
			return {
				content: toolSummaryText(toolCalls),
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: true,
				// The reply the user sees is the executor's summary, not the model's
				// narration — flagged when that narration did claim a change.
				claimCorrected: claimsStateChange(lastText) || undefined,
				provider,
				fellBack,
			};
		}

		// Replay the assistant's own blocks (text + tool_use) and answer each
		// tool_use with a matching tool_result in the following user turn —
		// the provider rejects a tool_use that is not answered immediately.
		conversation.push({ role: 'assistant', content: completion.blocks });
		conversation.push({ role: 'user', content: results.map(toToolResultBlock) });
	}

	// Unreachable: the loop returns on its final iteration.
	return {
		content: toolSummaryText(toolCalls),
		model,
		usage,
		toolCalls,
		iterations: MAX_TOOL_ITERATIONS,
		capped: true,
		claimCorrected: claimsStateChange(lastText) || undefined,
		provider,
		fellBack,
	};
}
