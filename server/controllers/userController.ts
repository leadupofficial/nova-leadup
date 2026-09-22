/**
 * User controller
 */

import type { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../utils/errors';
import type { User, UserRole } from '../types/user';

// In-memory placeholder store until the real DB-backed implementation is wired.
const USERS: User[] = [];

export const userController = {
 async getAllUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 res.status(StatusCodes.OK).json({ success: true, data: USERS, pagination: { page: 1, pageSize: 20, total: USERS.length, totalPages: 1 } });
 } catch (err) {
 next(err);
 }
 },

 async getCurrentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 const user = (req as any).user;
 if (!user) {
 next(new AppError('Unauthorized', StatusCodes.UNAUTHORIZED, false, 'UNAUTHORIZED'));
 return;
 }
 res.status(StatusCodes.OK).json({ success: true, data: user });
 } catch (err) {
 next(err);
 }
 },

 async getUserById(req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 const user = USERS.find((u) => u.id === req.params.id);
 if (!user) {
 next(new AppError('User not found', StatusCodes.NOT_FOUND, false, 'NOT_FOUND'));
 return;
 }
 res.status(StatusCodes.OK).json({ success: true, data: user });
 } catch (err) {
 next(err);
 }
 },

 async createUser(req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 const body = req.body;
 const user: User = {
 id: `user_${Date.now()}`,
 email: body.email,
 name: body.name,
 role: body.role ?? 'user',
 emailVerified: false,
 createdAt: new Date().toISOString(),
 updatedAt: new Date().toISOString(),
 };
 USERS.push(user);
 res.status(StatusCodes.CREATED).json({ success: true, data: user });
 } catch (err) {
 next(err);
 }
 },

 async updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 const idx = USERS.findIndex((u) => u.id === req.params.id);
 if (idx === -1) {
 next(new AppError('User not found', StatusCodes.NOT_FOUND, false, 'NOT_FOUND'));
 return;
 }

 USERS[idx] = { ...USERS[idx], ...req.body, id: USERS[idx].id, updatedAt: new Date().toISOString() };
 res.status(StatusCodes.OK).json({ success: true, data: USERS[idx] });
 } catch (err) {
 next(err);
 }
 },

 async updateUserStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 res.status(StatusCodes.OK).json({ success: true });
 } catch (err) {
 next(err);
 }
 },

 async deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
 try {
 const idx = USERS.findIndex((u) => u.id === req.params.id);
 if (idx === -1) {
 next(new AppError('User not found', StatusCodes.NOT_FOUND, false, 'NOT_FOUND'));
 return;
 }

 USERS.splice(idx, 1);
 res.status(StatusCodes.NO_CONTENT).send();
 } catch (err) {
 next(err);
 }
 },
};
