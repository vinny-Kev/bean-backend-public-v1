import { pool } from '../../db/pool.js';
import { compareToPattern, inRangeOfLength } from '../../util/validations.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';
import { auditLog } from '../../audit_logs/auditLog.js';

export const inventoryMiddleware = async (req, res, next) => {
    try {
        console.log("[INVENTORY MIDDLEWARE]: Start Process - Inventory middleware.");
        const { name, quantity, unit } = req.body;
        const rawSku = req.body.sku;

        const sku = typeof rawSku === 'string'
            ? rawSku.trim().toUpperCase()
            : null;

        if (!name || typeof name !== 'string' || !name.trim()) {
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'EMPTY/NULL ITEM NAME',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Empty/null inventory name.");
            return res.status(400).json({ message: 'Invalid inventory name.' });
        }

        if(!compareToPattern(name, "alphanumeric") || !inRangeOfLength(name, 3, 50)) {

            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'INVALID INTENTORY ITEM NAME',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Item name must be alphanumeric and between 3 to 50 characters.");
            return res.status(400).json({ message: 'Inventory name must be alphanumeric and between 3 to 50 characters.' });
        }

        if (!sku) {
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'NULL/EMPTY INTENTORY SKU VALUE',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Null/empty inventory SKU value.");
            return res.status(400).json({ message: 'Invalid inventory SKU.' });
        }

        if(!compareToPattern(sku, "sku") || !inRangeOfLength(sku, 3, 20)) {

            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'INVALID SKU VALUE',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Invalid SKU.");
            return res.status(400).json({ message: 'Invalid SKU.' });
        }

        if (quantity !== undefined && (typeof quantity !== 'number' || quantity < 0)) {

            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'INVALID QUANTITY VALUE',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Invalid inventory quantity.");
            return res.status(400).json({ message: 'Invalid inventory quantity.' });
        }

        const duplicateCheckQuery = 'SELECT * FROM inventory WHERE sku = $1';
        const duplicateCheckResult = await pool.query(duplicateCheckQuery, [sku]);
        if (duplicateCheckResult.rows.length > 0) {

            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");
            const auditEntry = auditLog({
                userId: req.user.id,
                action: 'DUPLICATE INVENTORY ITEM',
                tableName: 'inventory',
                recordId: null,
                oldData: null,
                newData: { name, quantity, unit, sku },
            });
            await composeAuditLogs(auditEntry);
            console.log("[INVENTORY MIDDLEWARE]: Compose Audit Logs");

            console.log("[INVENTORY MIDDLEWARE]: End Process - Item already exists.");
            
            return res.status(400).json({ message: 'Inventory item with this SKU already exists.' });
        }

        req.body = {
            ...req.body,
            sku,
        }

        return next();
    } catch(error) {
        console.error("[INVENTORY MIDDLEWARE]: End Process - Error during inventory middleware:", error);
        return res.status(500).json({ message: 'Internal server error during inventory middleware.' });
    }
};