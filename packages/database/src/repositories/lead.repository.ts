import { eq, and, or, desc, asc, like, inArray, gte, lte, isNull, sql, count, sum, avg } from 'drizzle-orm';
import { BaseRepository } from '../utils/base-repository.js';
import { leads, users } from '../schema.js';
import type { Database } from '../client.js';

type LeadRow = typeof leads.$inferSelect;
type LeadInsert = typeof leads.$inferInsert;

export interface LeadQueryOptions {
	status?: string | 'ALL';
	priority?: string | 'ALL';
	source?: string | 'ALL';
	service?: string | 'ALL';
	assignedTo?: string;
	searchQuery?: string;
	startDate?: Date;
	endDate?: Date;
	minBudget?: string;
	maxBudget?: string;
	limit?: number;
	offset?: number;
	orderBy?: 'createdAt' | 'budget' | 'priority' | 'name';
	orderDirection?: 'asc' | 'desc';
}

export type LeadWithAssigner = Omit<LeadRow, 'assignedTo'> & {
	assignedTo?: {
		id: string;
		name: string;
		email: string | null;
	};
};

export class LeadRepository extends BaseRepository<LeadRow> {
	constructor(db: Database) {
		super(db, leads);
	}

	async findById(id: string, currentUserId?: string): Promise<LeadRow | undefined> {
		if (!currentUserId) {
			return super.findById(id);
		}
		const [result] = await this.db
			.select()
			.from(leads)
			.where(and(eq(leads.id, id), eq(leads.userId, currentUserId)))
			.limit(1);
		return result;
	}

	async findByAssignedUser(currentUserId: string, assignedTo: string): Promise<LeadRow[]> {
		return this.db.select().from(leads).where(and(eq(leads.userId, currentUserId), eq(leads.assignedTo, assignedTo)));
	}

	async findByIdWithAssigner(id: string, currentUserId: string): Promise<LeadWithAssigner | undefined> {
		const result = await this.db
			.select({
				lead: leads,
				assignedTo: users,
			})
			.from(leads)
			.leftJoin(users, eq(leads.assignedTo, users.id))
			.where(and(eq(leads.id, id), eq(leads.userId, currentUserId)))
			.limit(1);

		if (!result[0]) return undefined;

		const { lead, assignedTo } = result[0];

		return {
			...lead,
			assignedTo: assignedTo
				? {
						id: assignedTo.id,
						name: assignedTo.name,
						email: assignedTo.email,
					}
				: undefined,
		};
	}

	async findActive(
		currentUserId: string,
		options?: Omit<LeadQueryOptions, 'status'>,
	): Promise<LeadRow[]> {
		if (!currentUserId) {
			throw new Error('currentUserId is required');
		}

		const {
			priority,
			source,
			service,
			assignedTo,
			searchQuery,
			startDate,
			endDate,
			minBudget,
			maxBudget,
			limit = 50,
			offset = 0,
			orderBy = 'createdAt',
			orderDirection = 'desc',
		} = options || {};

		const conditions = [
			eq(leads.userId, currentUserId),
			or(
				eq(leads.status, 'NEW'),
				eq(leads.status, 'CONTACTED'),
				eq(leads.status, 'QUALIFIED'),
				eq(leads.status, 'PROPOSAL_SENT')
			),
		];

		if (priority && priority !== 'ALL') {
			conditions.push(eq(leads.priority, priority));
		}

		if (source && source !== 'ALL') {
			conditions.push(eq(leads.source, source));
		}

		if (service && service !== 'ALL') {
			conditions.push(eq(leads.service, service));
		}

		if (assignedTo) {
			conditions.push(eq(leads.assignedTo, assignedTo));
		}

		if (startDate) {
			conditions.push(gte(leads.createdAt, startDate));
		}

		if (endDate) {
			conditions.push(lte(leads.createdAt, endDate));
		}

		if (minBudget !== undefined) {
			conditions.push(gte(leads.budget, minBudget));
		}

		if (maxBudget !== undefined) {
			conditions.push(lte(leads.budget, maxBudget));
		}

		if (searchQuery) {
			conditions.push(
				or(
					like(leads.name, `%${searchQuery}%`),
					like(leads.email, `%${searchQuery}%`),
					like(leads.phone, `%${searchQuery}%`),
					like(leads.location, `%${searchQuery}%`)
				)
			);
		}

		let query = this.db.select().from(leads).where(and(...conditions)).$dynamic();

		const orderColumn = leads[orderBy as keyof typeof leads];
		query = query.orderBy(orderDirection === 'asc' ? asc(orderColumn as any) : desc(orderColumn as any));
		query = query.limit(limit).offset(offset);

		return query;
	}

	async assignUser(leadId: string, assignedTo: string): Promise<LeadRow | undefined> {
		const [result] = await this.db
			.update(leads)
			.set({ assignedTo, updatedAt: new Date() })
			.where(eq(leads.id, leadId))
			.returning();

		return result;
	}

	async updateStatus(leadId: string, status: string): Promise<LeadRow | undefined> {
		const [result] = await this.db
			.update(leads)
			.set({ status, updatedAt: new Date() })
			.where(eq(leads.id, leadId))
			.returning();

		return result;
	}

	async getStatsByStatus(currentUserId: string) {
		const result = await this.db
			.select({
				status: leads.status,
				count: count(),
				totalBudget: sum(leads.budget),
			})
			.from(leads)
			.where(eq(leads.userId, currentUserId))
			.groupBy(leads.status);

		return result.map((row) => ({
			status: row.status,
			count: Number(row.count || 0),
			totalBudget: row.totalBudget || '0',
		}));
	}

	async getStatsBySource(currentUserId: string, startDate?: Date, endDate?: Date) {
		const conditions = [eq(leads.userId, currentUserId)];

		if (startDate) {
			conditions.push(gte(leads.createdAt, startDate));
		}
		if (endDate) {
			conditions.push(lte(leads.createdAt, endDate));
		}

		let query = this.db
			.select({
				source: leads.source,
				count: count(),
				totalBudget: sum(leads.budget),
			})
			.from(leads).$dynamic();

		if (conditions.length > 0) {
			query = query.where(and(...conditions));
		}

		query = query.groupBy(leads.source);

		const result = await query;
		return result.map((row) => ({
			source: row.source,
			count: Number(row.count || 0),
			totalBudget: row.totalBudget || '0',
		}));
	}

	async getStatsByService(currentUserId: string, startDate?: Date, endDate?: Date) {
		const conditions = [eq(leads.userId, currentUserId)];

		if (startDate) {
			conditions.push(gte(leads.createdAt, startDate));
		}
		if (endDate) {
			conditions.push(lte(leads.createdAt, endDate));
		}

		let query = this.db
			.select({
				service: leads.service,
				count: count(),
				totalBudget: sum(leads.budget),
				avgBudget: avg(leads.budget),
			})
			.from(leads).$dynamic();

		if (conditions.length > 0) {
			query = query.where(and(...conditions));
		}

		query = query.groupBy(leads.service);

		const result = await query;
		return result.map((row) => ({
			service: row.service,
			count: Number(row.count || 0),
			totalBudget: row.totalBudget || '0',
			avgBudget: row.avgBudget || '0',
		}));
	}

	async getConversionStats(currentUserId: string) {
		const totalLeads = await this.db
			.select({ count: count() })
			.from(leads)
			.where(eq(leads.userId, currentUserId))
			.then((r) => Number(r[0]?.count || 0));

		const closedWon = await this.db
			.select({ count: count() })
			.from(leads)
			.where(and(eq(leads.userId, currentUserId), eq(leads.status, 'CLOSED_WON')));

		const closedLost = await this.db
			.select({ count: count() })
			.from(leads)
			.where(and(eq(leads.userId, currentUserId), eq(leads.status, 'CLOSED_LOST')));

		const wonCount = Number(closedWon[0]?.count || 0);
		const lostCount = Number(closedLost[0]?.count || 0);

		return {
			total: totalLeads,
			won: wonCount,
			lost: lostCount,
			conversionRate: totalLeads > 0 ? (wonCount / totalLeads) * 100 : 0,
		};
	}

	async create(data: Partial<LeadInsert>): Promise<LeadRow> {
		// `create` deliberately accepts a partial insert (columns with database
		// defaults may be omitted); Drizzle's `values()` overload requires the
		// full insert type, so the partial is asserted here.
		const [result] = await this.db.insert(leads).values(data as LeadInsert).returning();
		return result;
	}

	async update(id: string, data: Partial<LeadInsert>): Promise<LeadRow | undefined> {
		const [result] = await this.db.update(leads).set(data).where(eq(leads.id, id)).returning();
		return result;
	}

	async delete(id: string): Promise<boolean> {
		const result = await this.db.delete(leads).where(eq(leads.id, id));
		return (result.rowCount || 0) > 0;
	}
}
