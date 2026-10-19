import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';

export const readInventoryService = async (req, res) => {
    try {
        console.log('[INVENTORY SERVICE]: Start Process - Reading inventory data.');

        const result = await pool.query('SELECT id, name, sku, quantity, unit, created_at, updated_at FROM inventory');
        console.log('[INVENTORY SERVICE]: End Process SUCCESS - Inventory data retrieved successfully.');

        if (result.rows.length === 0) {
            console.log('[INVENTORY SERVICE]: End Process - No inventory data found.');
            return res.status(404).json({ message: 'No inventory data found.' });
        } 

        console.log("[INVENTORY SERVICE]: Compose Audit Logs")
        const auditEntry = auditLog({
            userId: req.user.id,
            action: 'READ INVENTORY',
            tableName: 'inventory',
            recordId: null,
            oldData: null,
            newData: null,
        })
        await composeAuditLogs(auditEntry)

        const responseObject = result.rows.map(item => ({
            id: item.id,
            name: item.name,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
        }));

        return res.status(201).json({ message: 'Inventory data retrieved successfully.', data: responseObject });
    } catch (error) {
        console.error('[INVENTORY SERVICE]: End Process - Error during inventory service:', error);
        return res.status(500).json({ message: 'Internal server error during inventory service.' });
    }
};

export const addInvetoryItemService = async (req, res) => {
    let client;
 
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        console.log('[INVENTORY SERVICE]: Start Process - Adding inventory item:', req.body);
        const { name, sku, quantity, unit } = req.body;

        const result = await client.query(
            `
            INSERT INTO inventory (name, sku, quantity, unit)
            VALUES ($1, $2, $3, $4)
            RETURNING id, name, sku, quantity, unit, created_at
            `,
            [name, sku ?? null, quantity ?? 0, unit ?? 'unit']
        );

        const item = result.rows[0];
        if (!item) {
            console.log('[INVENTORY SERVICE]: End Process - Failed to add inventory item.');
            throw new Error('Inventory insert returned no item.');
        }
        console.log('[INVENTORY SERVICE]: Inventory item added successfully:', item);

        console.log("[INVENTORY SERVICE]: Compose Audit Logs")
        const auditEntry = auditLog({
            userId: req.user.id,
            action: 'CREATE INVENTORY',
            tableName: 'inventory',
            recordId: item.id,
            oldData: null,
            newData: item,
        })
        
        await composeAuditLogs(auditEntry, client)
        await client.query('COMMIT');

        const responseObject = {
            id: item.id,
            name: item.name,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            createdAt: item.created_at,
        };

        return res.status(200).json({ message: 'Inventory data inserted successfully.', data: responseObject });
    }
    catch (err){
        if(client) {
            await client
            .query('ROLLBACK')
            .catch((rollbackError)=>{
                console.error('[INVENTORY SERVICE]: Error during transaction rollback:', rollbackError);
            }
        )};

    
        console.error('[INVENTORY SERVICE]: End Process - Error during adding inventory item:', err);
        return res.status(500).json({ message: 'Internal server error during adding inventory item.' });
    }
    finally{
        client?.release();
    }
};


export const updateInventoryItemService = async (req, res) => {
    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        console.log('[INVENTORY SERVICE]: Start Process - Updating inventory item:', req.body);
        const { name, sku, quantity, unit } = req.body;

        const existingResult = await client.query(
            `
            SELECT id, name, sku, quantity, unit, created_at, updated_at
            FROM inventory
            WHERE id = $1
            FOR UPDATE
            `,
            [req.params.id]
        );

        const oldItem = existingResult.rows[0];
        if (!oldItem) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Inventory item not found.' });
        }

        const result = await client.query(
            `
            UPDATE inventory
            SET name = $1,
                sku = $2,
                quantity = $3,
                unit = $4,
                updated_at = NOW()
            WHERE id = $5
            RETURNING id, name, sku, quantity, unit, created_at, updated_at
            `,
            [name, sku ?? null, quantity ?? 0, unit ?? 'unit', req.params.id]
        );

        const item = result.rows[0];
        if (!item) {
            console.log('[INVENTORY SERVICE]: End Process - Failed to update inventory item.');
            throw new Error('Inventory update returned no item.');
        }
        console.log('[INVENTORY SERVICE]: Inventory item updated successfully:', item);

        console.log("[INVENTORY SERVICE]: Compose Audit Logs")
        const auditEntry = auditLog({
            userId: req.user.id,
            action: 'UPDATE INVENTORY',
            tableName: 'inventory',
            recordId: item.id,
            oldData: oldItem,
            newData: item,
        })
        await composeAuditLogs(auditEntry, client)
        await client.query('COMMIT');

        const responseObject = {
            id: item.id,
            name: item.name,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
        };
        return res.status(200).json({ message: 'Inventory item updated successfully.', data: responseObject });
    }
    catch (err){
        if(client) {
            await client
            .query('ROLLBACK')
            .catch((rollbackError)=>{
                console.error('[INVENTORY SERVICE]: Error during transaction rollback:', rollbackError);
            }
        )};

        if (err.code === '23505') {
            return res.status(409).json({ message: 'Another inventory item already uses this SKU.' });
        }

        console.error('[INVENTORY SERVICE]: End Process - Error during updating inventory item:', err);
        return res.status(500).json({ message: 'Internal server error during updating inventory item.' });
    }
    finally{
        client?.release();
    }
}
