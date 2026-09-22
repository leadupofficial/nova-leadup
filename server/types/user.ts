/**
 * User type definitions
 */

export enum UserRole {
 ADMIN = 'admin',
 USER = 'user',
 MODERATOR = 'moderator',
}

export interface User {
 id: string;
 email: string;
 name: string;
 role: UserRole;
 emailVerified: boolean;
 createdAt: string;
 updatedAt: string;
}
