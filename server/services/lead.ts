/**
 * NOVA-Leadup — Lead domain service.
 *
 * Responsibilities
 * ────────────────
 * • Normalise emails and phone numbers so that "John@Example.COM",
 * " john@example.com ", and "+1 (555) 123-4567" all collapse to the
 * same canonical representation before any lookup.
 * • Detect duplicates with a three-tier priority:
 * 1. Exact e-mail match → score 1.00
 * 2. Exact phone match (both → score 0.95
 * present and equal)
 * 3. Fuzzy full-name match → score 0.00-0.90
 * (Levenshtein distance /
 * max-length, lower-cased)
 * • Return the matching existing lead id (if any) and a
 * normalised similarity score so callers can decide whether to
 * treat a result as a hard block (≥ 0.95) or just surface a
 * "did you mean?" hint.
 */

import { logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────

export interface DuplicateCheckParams {
	email: string;
	phone?: string | null;
	firstName: string;
	lastName?: string;
}

export interface DuplicateResult {
	existingLeadId?: string;
	emailMatch: boolean;
	phoneMatch: boolean;
	fuzzyMatch: boolean;
	similarityScore: number; // 0 – 1
}

// ─── Normalisation helpers ────────────────────────────────────────────────

/**
 * Strip surrounding whitespace and lower-case an e-mail address.
 * Does NOT attempt IDN → ASCII conversion; keep the raw bytes after
 * lower-casing so the DB unique index matches whatever the caller
 * stored.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Convert a phone string to E.164 for reliable equality checks.
 * Strips everything except digits and a leading '+'.
 * Returns `null` when the input is empty / only punctuation.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
	if (!phone) return null;
	const digits = phone.replace(/[^\d+]/g, '');
	if (!digits) return null;
	// Ensure exactly one leading '+'
	const e164 = digits.startsWith('+') ? digits : `+${digits}`;
	// Must be between 8 and 16 digits (ITU-T E.164)
	const digitCount = (e164.match(/\d/g) || []).length;
	if (digitCount < 8 || digitCount > 16) return null;
	return e164;
}

// ─── Fuzzy string distance ────────────────────────────────────────────────

/**
 * Classic Levenshtein distance (O(m·n), m,n ≤ 100 for names).
 */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;

	// Two-row rolling buffer
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = new Array<number>(n + 1);

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

/**
 * Normalised similarity in [0, 1].
 * 1.0 = identical
 * 0.0 = completely different
 *
 * Uses 1 - distance / max(len(a), len(b)) so a single-character
 * typo in a short name doesn't blow the score.
 */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const dist = levenshtein(a, b);
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - dist / maxLen;
}

// ─── Lead store (in-memory; replace with real DB) ────────────────────────

export interface LeadRow {
	id: string;
	email: string;
	phone: string | null;
	firstName: string;
	lastName: string | null;
	company: string | null;
	source: string | null;
	status: string;
	notes: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
}

// In production: replace with `SELECT … FROM leads` via your DB client.
const leadStore: LeadRow[] = [];

/**
 * Look up an existing lead by id.
 * Replace with `SELECT * FROM leads WHERE id = $1` in production.
 */
export async function findLeadById(id: string): Promise<LeadRow | undefined> {
	return leadStore.find((l) => l.id === id);
}

/**
 * Find leads by exact e-mail.
 */
export async function findLeadByEmail(email: string): Promise<LeadRow | undefined> {
	return leadStore.find((l) => l.email === email);
}

/**
 * Find leads by exact normalised phone.
 */
export async function findLeadByPhone(phone: string): Promise<LeadRow | undefined> {
	return leadStore.find((l) => l.phone === phone);
}

/**
 * Return a snapshot of all leads (in-memory store).
 * Replace with `SELECT … FROM leads ORDER BY created_at DESC LIMIT $1 OFFSET $2` in production.
 *
 * Returned array is a shallow copy so callers can slice/filter without
 * mutating the underlying store.
 */
export async function listAllLeads(): Promise<LeadRow[]> {
	return leadStore.slice();
}

/**
 * Scan all existing leads for a fuzzy full-name match.
 * Replace with a trigram / pg_trgm query in PostgreSQL for production.
 */
export async function fuzzyMatchLeads(
	firstName: string,
	lastName: string | undefined,
	threshold = 0.8
): Promise<{ lead: LeadRow; score: number } | undefined> {
	const target = `${firstName.toLowerCase()} ${(lastName ?? '').toLowerCase()}`.trim();

	let best: { lead: LeadRow; score: number } | undefined;
	for (const lead of leadStore) {
		const candidate = `${lead.firstName.toLowerCase()} ${(lead.lastName ?? '').toLowerCase()}`.trim();
		const score = similarity(target, candidate);
		if (score >= threshold && (!best || score > best.score)) {
			best = { lead, score };
		}
	}
	return best;
}

/**
 * Persist a new lead row. Replace with INSERT in production.
 */
export async function insertLead(row: Partial<LeadRow> & { email: string; firstName: string }): Promise<LeadRow> {
	const lead: LeadRow = {
		id: row.id ?? crypto.randomUUID(),
		email: normalizeEmail(row.email),
		phone: row.phone ? normalizePhone(row.phone) ?? null : null,
		firstName: row.firstName,
		lastName: row.lastName ?? null,
		company: row.company ?? null,
		source: row.source ?? null,
		status: row.status ?? 'new',
		notes: row.notes ?? null,
		metadata: row.metadata ?? {},
		createdAt: row.createdAt ?? new Date(),
	};
	leadStore.push(lead);
	logger.info({ leadId: lead.id, email: lead.email }, 'Lead inserted');
	return lead;
}

// ─── Duplicate check (core logic) ─────────────────────────────────────────

/**
 * Check whether a new lead already exists in the system.
 *
 * **Priority order (highest → lowest)**
 * 1. Exact e-mail match → score 1.00
 * 2. Exact phone match (both set) → score 0.95
 * 3. Fuzzy full-name match → score computed by Levenshtein
 *
 * A caller should treat any result with `similarityScore >= 0.95` as a
 * hard block and surface the `existingLeadId` to the operator.
 */
export async function checkDuplicate(params: DuplicateCheckParams): Promise<DuplicateResult> {
	const normEmail = normalizeEmail(params.email);
	const normPhone = normalizePhone(params.phone);

	const result: DuplicateResult = {
		emailMatch: false,
		phoneMatch: false,
		fuzzyMatch: false,
		similarityScore: 0,
	};

	// Tier 1 — exact e-mail
	const byEmail = await findLeadByEmail(normEmail);
	if (byEmail) {
		result.existingLeadId = byEmail.id;
		result.emailMatch = true;
		result.similarityScore = 1;
		return result;
	}

	// Tier 2 — exact phone (only meaningful when both have a number)
	if (normPhone) {
		const byPhone = await findLeadByPhone(normPhone);
		if (byPhone) {
			result.existingLeadId = byPhone.id;
			result.phoneMatch = true;
			result.similarityScore = 0.95;
			return result;
		}
	}

	// Tier 3 — fuzzy name match (score 0 – 0.90)
	const fuzzy = await fuzzyMatchLeads(params.firstName, params.lastName, 0.8);
	if (fuzzy) {
		result.existingLeadId = fuzzy.lead.id;
		result.fuzzyMatch = true;
		result.similarityScore = Math.min(fuzzy.score, 0.9);
	}

	return result;
}

// ─── Update / delete helpers (controllers should call these) ──────────────

/**
 * Update a lead by id. Returns the updated row or `undefined` if not found.
 */
export async function updateLeadById(
	id: string,
	patch: Partial<Omit<LeadRow, 'id' | 'createdAt'>>
): Promise<LeadRow | undefined> {
	const idx = leadStore.findIndex((l) => l.id === id);
	if (idx === -1) return undefined;
	const row = leadStore[idx];
	const updated: LeadRow = {
		...row,
		...patch,
		email: patch.email ? normalizeEmail(patch.email) : row.email,
		phone: patch.phone !== undefined ? (patch.phone ? normalizePhone(patch.phone) ?? null : null) : row.phone,
	};
	leadStore[idx] = updated;
	logger.info({ leadId: id }, 'Lead updated');
	return updated;
}

/**
 * Delete a lead by id. Returns `true` when a row was removed.
 */
export async function deleteLeadById(id: string): Promise<boolean> {
	const idx = leadStore.findIndex((l) => l.id === id);
	if (idx === -1) return false;
	leadStore.splice(idx, 1);
	logger.info({ leadId: id }, 'Lead deleted');
	return true;
}
