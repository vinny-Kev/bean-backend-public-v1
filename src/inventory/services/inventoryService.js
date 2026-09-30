import { pool } from '../../db/pool.js';
import { auditLog } from '../../audit_logs/auditLog.js';
import { composeAuditLogs } from '../../audit_logs/auditLogService.js';

export const readInventoryService = async (req, res) => {
    try {
        console.log('[INVENTORY SERVICE]: Start Process - Reading inventory data.');

        const result = await pool.query('SELECT * FROM inventory');
        console.log('[INVENTORY SERVICE]: End Process SUCCESS - Inventory data retrieved successfully.');

        if (result.rows.length === 0) {
            console.log('[INVENTORY SERVICE]: End Process - No inventory data found.');
            return res.status(404).json({ message: 'No inventory data found.' });
        }

        console.log("[INVENTORY SERVICE]: Compose Audit Logs")
        const auditEntry = auditLog({
            userId: req.user.id,
            action: 'READ DATABASE INVENTORY',
            tableName: 'inventory',
            recordId: null,
            oldData: null,
            newData: null,
        })
        await composeAuditLogs(auditEntry)

        return res.status(200).json({ inventory: result.rows });
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
            RETURNING *
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
            action: 'ADD DATABASE INVENTORY',
            tableName: 'inventory',
            recordId: item.id,
            oldData: null,
            newData: item,
        })
        

        await composeAuditLogs(auditEntry, client)

        await client.query('COMMIT');

        console.log('[INVENTORY SERVICE]: End Process SUCCESS - Inventory item added successfully:', result.rows[0]);
        return res.status(201).json({ message: 'Inventory item added successfully.', item });
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