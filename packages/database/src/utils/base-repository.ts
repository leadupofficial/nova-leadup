import { sql, SQL, eq, and, or, like, inArray, desc, asc } from 'drizzle-orm';
import { Database } from '../client';

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
  protected readonly db: Database;
  protected readonly table: any;

  constructor(protected readonly config: RepositoryConfig) {
    this.db = config.db;
    this.table = config.table;
  }

  async findById(id: string): Promise<T | undefined> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }
    const result = await this.db.client.select().from(this.table).where(eq(this.table.id, id)).limit(1);
    return result[0];
  }

  async findByIds(ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const validIds = ids.filter(id => this.isValidUUID(id));
    if (!validIds.length) return [];
    return this.db.client.select().from(this.table).where(inArray(this.table.id, validIds));
  }

  async findAll(options?: QueryOptions): Promise<T[]> {
    const { limit = 50, offset = 0, orderBy, filters, searchFields, searchQuery } = options || {};

    let query = this.db.client.select().from(this.table);

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
      query = query.orderBy(orderBy);
    }

    query = query.limit(limit).offset(offset);

    return query;
  }

  async count(filters?: Record<string, any>): Promise<number> {
    let query = this.db.client.select({ count: sql<number>`count(*)` }).from(this.table);

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
    const result = await this.db.client.insert(this.table).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return result[0];
  }

  async createMany(data: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>): Promise<T[]> {
    const now = new Date();
    const values = data.map(item => ({
      ...item,
      createdAt: now,
      updatedAt: now,
    }));

    return this.db.client.insert(this.table).values(values).returning();
  }

  async update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T | undefined> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }

    const result = await this.db.client
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

    const result = await this.db.client
      .update(this.table)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(inArray(this.table.id, validIds));

    return result.rowCount || 0;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.isValidUUID(id)) {
      throw new Error('Invalid UUID format');
    }

    const result = await this.db.client.delete(this.table).where(eq(this.table.id, id));
    return result.rowCount > 0;
  }

  async deleteMany(ids: string[]): Promise<number> {
    const validIds = ids.filter(id => this.isValidUUID(id));
    if (!validIds.length) return 0;

    const result = await this.db.client.delete(this.table).where(inArray(this.table.id, validIds));
    return result.rowCount || 0;
  }

  async exists(id: string): Promise<boolean> {
    if (!this.isValidUUID(id)) return false;
    const result = await this.db.client.select({ count: sql<number>`count(*)` }).from(this.table).where(eq(this.table.id, id));
    return Number(result[0]?.count || 0) > 0;
  }

  protected isValidUUID(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }
}
