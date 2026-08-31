import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { authenticate } from '../middleware/auth';
import { memoryService } from '../services/memory';

export const memoryRouter = Router();

memoryRouter.use(authenticate);

// Store a memory
memoryRouter.post('/store', asyncHandler(async (req, res) => {
 const { content, type, metadata } = req.body;

 if (!content) {
 return res.status(400).json({ error: 'Content is required' });
 }

 const memory = await memoryService.store({
 userId: req.user!.id,
 content,
 type: type || 'conversation',
 metadata,
 });

 res.status(201).json(memory);
}));

// Search memories
memoryRouter.get('/search', asyncHandler(async (req, res) => {
 const query = req.query.q as string;
 const limit = parseInt(req.query.limit as string) || 20;

 if (!query) {
 return res.status(400).json({ error: 'Query parameter q is required' });
 }

 const memories = await memoryService.search(req.user!.id, query, limit);
 res.json({ memories });
}));

// Get all memories
memoryRouter.get('/', asyncHandler(async (req, res) => {
 const limit = parseInt(req.query.limit as string) || 50;
 const offset = parseInt(req.query.offset as string) || 0;

 const memories = await memoryService.getAll(req.user!.id, limit, offset);
 res.json({ memories });
}));

// Delete a memory
memoryRouter.delete('/:id', asyncHandler(async (req, res) => {
 await memoryService.delete(req.user!.id, req.params.id);
 res.status(204).send();
}));
