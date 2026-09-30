import express from 'express';

const router = express.Router();
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { readInventoryService, addInvetoryItemService } from '../services/inventoryService.js';
import { inventoryMiddleware } from '../../middleware/inventory/inventoryMiddleware.js';


router.get('/health/', (req, res) => {
    res.json({ message: 'Inventory route is working!' });
});

router.get('/all/', 
    sessionAuthMiddleware,
    requirePermission('INVENTORY_READ'),
    readInventoryService
)

router.post('/add/',
    sessionAuthMiddleware,
    requirePermission('INVENTORY_ADD'),
    inventoryMiddleware,
    addInvetoryItemService
)
export default router;