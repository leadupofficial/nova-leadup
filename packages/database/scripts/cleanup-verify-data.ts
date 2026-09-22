/**
 * Dev-only: remove rows written by the verification scripts.
 *
 * The verifiers write real rows against real accounts — device registrations, platform-role
 * grants, AI-latency probe messages and voice-usage meter readings. They clean up most of it
 * themselves; this removes what a probe deliberately leaves behind so a development database does
 * not accumulate verification noise.
 *
 * Everything it deletes is matched by a name only a probe uses, so it cannot touch real data.
 */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', { max: 1 });

const devices = await sql`
	delete from devices
	where installation_id like 'verify-install-%'
	   or model like '%(verification)%'
	returning installation_id`;
console.log(`removed ${devices.length} verification device row(s)`);

const grants = await sql`
	delete from platform_admin_roles
	where granted_by = 'verify-owner@nova.test' or reason like '%verification%'
	returning role`;
console.log(`removed ${grants.length} verification role grant(s)`);

// Voice-usage rows written by the speech verification. Each is a real measurement of a real
// provider call, but it belongs to a probe rather than to a user's activity.
const usage = await sql`
	delete from usage_records
	where metric in ('tts_requests', 'tts_characters', 'stt_requests', 'stt_seconds')
	returning metric`;
console.log(`removed ${usage.length} voice-usage row(s)`);

// The latency probe rows, in case a run was interrupted before its own cleanup.
const probes = await sql`
	delete from conversation_messages where content = 'latency-probe' returning id`;
console.log(`removed ${probes.length} latency probe row(s)`);

const [remainingDevices] = await sql`select count(*)::int as n from devices`;
const [remainingGrants] = await sql`select count(*)::int as n from platform_admin_roles`;
const [remainingVoice] = await sql`
	select count(*)::int as n from usage_records
	where metric in ('tts_requests', 'tts_characters', 'stt_requests', 'stt_seconds')`;
console.log(
	`remaining — devices: ${remainingDevices.n}, grants: ${remainingGrants.n}, voice-usage: ${remainingVoice.n}`,
);

await sql.end();
