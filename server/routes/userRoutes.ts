import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler';
import { userController } from '../controllers/userController';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { createUserSchema, updateUserSchema, updateUserStatusSchema, paginationSchema } from '../utils/validationSchemas';
import { UserRole } from '../types/user';

const router = Router();

router.get(
 '/',
 authenticate,
 authorize(UserRole.ADMIN),
 validate(paginationSchema),
 asyncHandler(userController.getAllUsers)
);

router.get(
 '/me',
 authenticate,
 asyncHandler(userController.getCurrentUser)
);

router.get(
 '/:id',
 authenticate,
 authorize(UserRole.ADMIN),
 asyncHandler(userController.getUserById)
);

router.post(
 '/',
 authenticate,
 authorize(UserRole.ADMIN),
 validate(createUserSchema),
 asyncHandler(userController.createUser)
);

router.put(
 '/:id',
 authenticate,
 authorize(UserRole.ADMIN),
 validate(updateUserSchema),
 asyncHandler(userController.updateUser)
);

router.patch(
 '/:id/status',
 authenticate,
 authorize(UserRole.ADMIN),
 validate(updateUserStatusSchema),
 asyncHandler(userController.updateUserStatus)
);

router.delete(
 '/:id',
 authenticate,
 authorize(UserRole.ADMIN),
 asyncHandler(userController.deleteUser)
);

export default router;
