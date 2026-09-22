/**
 * Dev-only: record two timed assistant replies so the AI-latency metric can be read back
 * from the live API, then remove them.
 *
 * The point is to prove the whole chain — column, aggregation, percentile, metric shape —
 * without making a real model call, which would need provider credit.
 */
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', { max: 1 });

const [conv] = await sql`select id from conversations limit 1`;
if (!conv) { console.log('no conversation to attach to'); await sql.end(); process.exit(0); }

const probe = 'latency-probe';
const inserted = await sql`
	insert into conversation_messages (conversation_id, role, content, model, token_usage, duration_ms)
	values
		(${conv.id}, 'assistant', ${probe}, 'latency-probe-model', '{"inputTokens":10,"outputTokens":5}'::jsonb, 1000),
		(${conv.id}, 'assistant', ${probe}, 'latency-probe-model', '{"inputTokens":10,"outputTokens":5}'::jsonb, 3000)
	returning id`;
console.log(`inserted ${inserted.length} timed assistant rows (1000 ms and 3000 ms)`);
await sql.end();
