import express from 'express';

const router = express.Router();
import { sessionAuthMiddleware } from '../../middleware/auth/sessionAuthMiddleware.js';
import { requirePermission } from '../../middleware/auth/permissionMiddleware.js';
import { readInventoryService, addInvetoryItemService } from '../services/inventoryService.js';
import { inventoryMiddleware } from '../../middleware/inventory/inventoryMiddleware.js';
import { log } from '../../util/breadcrumb.js';

router.get('/health/', (req, res) => {
    log('INVENTORY_HEALTH', 'INVENTORY ROUTE START');
    res.json({ message: 'Inventory route is working!' });
});

router.get('/all/', 
    log('INVENTORY_READ', 'INVENTORY ROUTE START'),
    sessionAuthMiddleware,
    log('INVENTORY_READ', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requirePermission('INVENTORY_READ'),
    log('INVENTORY_READ', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    readInventoryService
)

router.post('/add/',
    log('INVENTORY_ADD', 'INVENTORY ROUTE START'),
    sessionAuthMiddleware,
    log('INVENTORY_ADD', 'SESSION MIDDLEWARE PASSED - USER AUTHENTICATED'),
    requirePermission('INVENTORY_CREATE'),
    log('INVENTORY_ADD', 'PERMISSION MIDDLEWARE PASSED - USER HAS PERMISSION'),
    inventoryMiddleware,
    log('INVENTORY_ADD', 'INVENTORY MIDDLEWARE PASSED - INVENTORY DATA VALIDATED'),
    addInvetoryItemService,
    log('INVENTORY_ADD', 'INVENTORY SERVICE PASSED - OPERATION SUCCESSFUL')
)
export default router;