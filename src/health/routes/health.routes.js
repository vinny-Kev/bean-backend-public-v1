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

// Public, unauthenticated, and deliberately minimal: no versions, hosts, or error text.
// Mounted before sessions and the origin check so probes never touch the session store,
// and it writes no audit entries.
export const createHealthRouter = ({ check = checkDatabase } = {}) => {
    const router = express.Router();

    // Liveness: the process is up and serving HTTP. Does not depend on the database.
    router.get('/', (_req, res) => {
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ status: 'ok' });
    });

    // Readiness: the database answers. 503 tells a load balancer to stop routing here.
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
