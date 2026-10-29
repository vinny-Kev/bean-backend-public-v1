import express from 'express';
import { pool } from '../../db/pool.js';

const databaseCheckTimeoutMs = 2000;

// A bare `SELECT 1` through the shared pool: cheap, and it fails when the pool cannot
// reach the database. The timeout keeps a hung database from hanging the probe.
export const checkDatabase = async (client = pool) => {
    let timer;
    try {
        await Promise.race([
            client.query('SELECT 1'),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Database check timed out.')), databaseCheckTimeoutMs);
            }),
        ]);
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
};


export const createHealthRouter = ({ check = checkDatabase } = {}) => {
    const router = express.Router();

    router.get('/', (_req, res) => {
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ status: 'ok' });
    });

    
    router.get('/ready', async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        const database = await check();
        return res.status(database ? 200 : 503).json({
            status: database ? 'ok' : 'unavailable',
            checks: { database: database ? 'ok' : 'unavailable' },
        });
    });

    return router;
};

export default createHealthRouter();
