import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { authenticate } from '../middleware/auth';
import { tasksService } from '../services/tasks';

export const tasksRouter = Router();

tasksRouter.use(authenticate);

// Create task
tasksRouter.post('/', asyncHandler(async (req, res) => {
 const task = await tasksService.create(req.user!.id, req.body);
 res.status(201).json(task);
}));

// List tasks
tasksRouter.get('/', asyncHandler(async (req, res) => {
 const { status, category, limit, offset } = req.query;
 const tasks = await tasksService.getAll(req.user!.id, {
 status: status as string,
 category: category as string,
 limit: limit ? parseInt(limit as string) : 50,
 offset: offset ? parseInt(offset as string) : 0,
 });
 res.json({ tasks });
}));

// Update task
tasksRouter.patch('/:id', asyncHandler(async (req, res) => {
 const task = await tasksService.update(req.user!.id, req.params.id, req.body);
 res.json(task);
}));

// Delete task
tasksRouter.delete('/:id', asyncHandler(async (req, res) => {
 await tasksService.delete(req.user!.id, req.params.id);
 res.status(204).send();
}));
