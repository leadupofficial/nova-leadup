import { eq, and, or, desc, asc, like, gte, lte, count, sql } from 'drizzle-orm';
import { BaseRepository } from '../utils/base-repository';
import { users } from '../schema';
import type { Database } from '../client';

export interface UserQueryOptions {
	searchQuery?: string;
	limit?: number;
	offset?: number;
	orderBy?: 'name' | 'email' | 'createdAt';
	orderDirection?: 'asc' | 'desc';
}

export class UserRepository extends BaseRepository {
	constructor(db: Database) {
		super(db, users);
	}

	async findByEmail(email: string): Promise<Record<string, unknown>> {
		const result = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
		return result[0] as Record<string, unknown>;
	}

	async findActiveUsers(options?: Omit<UserQueryOptions, 'isActive'>): Promise<Record<string, unknown>[]> {
		const { searchQuery, limit = 50, offset = 0, orderBy = 'createdAt', orderDirection = 'desc' } = options || {};

		const conditions = [eq(users.disabled, false)];

		if (searchQuery) {
			conditions.push(
				or(
					like(users.name, `%${searchQuery}%`),
					like(users.email, `%${searchQuery}%`)
				)
			);
		}

		let query = this.db.select().from(users).where(and(...conditions));
		const orderColumn = users[orderBy as keyof typeof users];
		query = query.orderBy(orderDirection === 'asc' ? asc(orderColumn) : desc(orderColumn));
		query = query.limit(limit).offset(offset);

		return query as Promise<Record<string, unknown>[]>;
	}

	async updateLastLogin(userId: string): Promise<Record<string, unknown> | undefined> {
		if (!this.isValidUUID(userId)) {
			throw new Error('Invalid UUID format');
		}

		const [result] = await this.db
			.update(users)
			.set({ updatedAt: new Date(), lastLoginAt: new Date() })
			.where(eq(users.id, userId))
			.returning();

		return result;
	}

	async countActive(): Promise<number> {
		const result = await this.db.select({ count: count() }).from(users).where(eq(users.disabled, false));
		return Number(result[0]?.count || 0);
	}

	async search(query: string, limit = 20): Promise<Record<string, unknown>[]> {
		if (!query.trim()) {
			return [];
		}

		return this.db
			.select()
			.from(users)
			.where(
				and(
					or(
						like(users.name, `%${query}%`),
						like(users.email, `%${query}%`)
					),
					eq(users.disabled, false)
				)
			)
			.limit(limit) as Promise<Record<string, unknown>[]>;
	}
}
