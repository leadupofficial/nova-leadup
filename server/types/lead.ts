/**
 * Lead type definitions
 */

export interface Lead {
 id: string;
 firstName: string;
 lastName: string;
 email: string;
 phone?: string;
 company?: string;
 source: string;
 status: LeadStatus;
 score?: number;
 notes?: string;
 metadata?: Record<string, unknown>;
 createdAt: string;
 updatedAt: string;
}

export enum LeadStatus {
 NEW = 'new',
 CONTACTED = 'contacted',
 QUALIFIED = 'qualified',
 PROPOSAL = 'proposal',
 NEGOTIATION = 'negotiation',
 WON = 'won',
 LOST = 'lost',
}

export interface LeadSearchFilters {
 query?: string;
 status?: LeadStatus;
 source?: string;
 company?: string;
 minScore?: number;
 maxScore?: number;
 createdAfter?: string;
 createdBefore?: string;
 limit?: number;
 offset?: number;
}

export interface LeadDuplicateCheck {
 emailMatch: boolean;
 phoneMatch: boolean;
 fuzzyMatch: boolean;
 existingLeadId?: string;
 similarityScore: number;
}
