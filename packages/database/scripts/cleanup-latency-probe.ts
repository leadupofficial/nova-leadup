/** Dev-only: remove the timed probe rows written by probe-latency.ts. */
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', { max: 1 });
const removed = await sql`delete from conversation_messages where content = 'latency-probe' returning id`;
console.log(`removed ${removed.length} latency probe row(s)`);
await sql.end();
