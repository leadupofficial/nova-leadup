import { sql, SQL, eq, and, or, like, inArray, desc, asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from '../client.js';

/**
 * The Drizzle client instance exposed by `Database#client`.
 *
 * Subclasses receive the `Database` wrapper but talk to the ORM directly, so
 * the base class stores the ORM client under `this.db`.
 */
type DrizzleClient = ReturnType<typeof drizzle>;

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: SQL | SQL[];
  filters?: Record<string, any>;
  searchFields?: string[];
  searchQuery?: string;
}

export interface RepositoryConfig {
  db: Database;
  table: any;
}

export abstract class BaseRepository<T extends { id: string }> {
  protected readonly db: DrizzleClient;
  protected readonly table: any;

  constructor(db: Database, table: any) {
    this.db = db.client;
    this.table = table;
  }

  async findById(id: string): Promise<T | undefined> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }
    const result = await this.db.select().from(this.table).where(eq(this.table.id, id)).limit(1);
    return result[0];
  }

  async findByIds(ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const validIds = ids.filter(id => this.isValidUUID(id));
    if (!validIds.length) return [];
    return this.db.select().from(this.table).where(inArray(this.table.id, validIds));
  }

  async findAll(options?: QueryOptions): Promise<T[]> {
    const { limit = 50, offset = 0, orderBy, filters, searchFields, searchQuery } = options || {};

    // `$dynamic()` keeps the builder's type stable across the conditional
    // `.where()` calls below.
    let query = this.db.select().from(this.table).$dynamic();

    if (searchQuery && searchFields?.length) {
      const conditions = searchFields
        .map(field => like(this.table[field], `%${searchQuery}%`))
        .filter(Boolean);

      if (conditions.length > 0) {
        query = query.where(or(...conditions));
      }
    }

    if (filters) {
      const filterConditions = Object.entries(filters)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            return inArray(this.table[key], value);
          }
          if (typeof value === 'string' && value.startsWith('%')) {
            return like(this.table[key], value);
          }
          return eq(this.table[key], value);
        })
        .filter(Boolean);

      if (filterConditions.length > 0) {
        query = query.where(and(...filterConditions));
      }
    }

    if (orderBy) {
      query = query.orderBy(...(Array.isArray(orderBy) ? orderBy : [orderBy]));
    }

    query = query.limit(limit).offset(offset);

    return query as unknown as T[];
  }

  async count(filters?: Record<string, any>): Promise<number> {
    let query = this.db.select({ count: sql<number>`count(*)` }).from(this.table).$dynamic();

    if (filters) {
      const filterConditions = Object.entries(filters)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => eq(this.table[key], value))
        .filter(Boolean);

      if (filterConditions.length > 0) {
        query = query.where(and(...filterConditions));
      }
    }

    const result = await query;
    return Number(result[0]?.count || 0);
  }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const now = new Date();
    // `this.table` is `any`, so Drizzle cannot infer the inserted row type and
    // reports a union with the raw `QueryResult`; the runtime value is the
    // `.returning()` row array.
    const rows = (await this.db.insert(this.table).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    }).returning()) as unknown as T[];
    return rows[0];
  }

  async createMany(data: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>): Promise<T[]> {
    const now = new Date();
    const values = data.map(item => ({
      ...item,
      createdAt: now,
      updatedAt: now,
    }));

    return this.db.insert(this.table).values(values).returning() as unknown as Promise<T[]>;
  }

  async update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T | undefined> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }

    const result = await this.db
      .update(this.table)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(this.table.id, id))
      .returning();

    return result[0];
  }

  async updateMany(ids: string[], data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<number> {
    const validIds = ids.filter(id => this.isValidUUID(id));
    if (!validIds.length) return 0;

    const result = await this.db
      .update(this.table)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(inArray(this.table.id, validIds));

    return result.rowCount ?? 0;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }

    const result = await this.db.delete(this.table).where(eq(this.table.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMany(ids: string[]): Promise<number> {
    const validIds = ids.filter(id => this.isValidUUID(id));
    if (!validIds.length) return 0;

    const result = await this.db.delete(this.table).where(inArray(this.table.id, validIds));
    return result.rowCount ?? 0;
  }

  async exists(id: string): Promise<boolean> {
    if (!this.isValidUUID(id)) return false;
    const result = await this.db.select({ count: sql<number>`count(*)` }).from(this.table).where(eq(this.table.id, id));
    return Number(result[0]?.count || 0) > 0;
  }

  protected isValidUUID(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }
}
