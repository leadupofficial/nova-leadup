import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler';
import { authenticate } from '../middleware/auth';
import { chatService } from '../services/chat';

export const chatRouter = Router();

chatRouter.use(authenticate);

// Send a message
chatRouter.post('/message', asyncHandler(async (req, res) => {
 const { message, conversationId } = req.body;

 if (!message || typeof message !== 'string') {
 return res.status(400).json({ error: 'Message is required' });
 }

 const response = await chatService.sendMessage({
 userId: req.user!.id,
 message,
 conversationId,
 });

 res.json({
 id: response.id,
 content: response.content,
 role: 'assistant',
 timestamp: new Date().toISOString(),
 });
}));

// Get conversation history
chatRouter.get('/conversations/:id', asyncHandler(async (req, res) => {
 const messages = await chatService.getConversation(req.user!.id, req.params.id);
 res.json({ messages });
}));

// List conversations
chatRouter.get('/conversations', asyncHandler(async (req, res) => {
 const conversations = await chatService.listConversations(req.user!.id);
 res.json({ conversations });
}));

// Delete conversation
chatRouter.delete('/conversations/:id', asyncHandler(async (req, res) => {
 await chatService.deleteConversation(req.user!.id, req.params.id);
 res.status(204).send();
}));
