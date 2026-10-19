import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool(config.database);

pool.on('error', () => {
    console.error(JSON.stringify({ level: 'error', event: 'postgres_pool_idle_client_error' }));
});
