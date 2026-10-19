import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config.js';
import { pool } from './db/pool.js';
import { requireTrustedOrigin } from './middleware/auth/originMiddleware.js';
import { errorHandler, notFoundHandler, requestContext } from './middleware/errorMiddleware.js';
import inventoryRoutes from './inventory/routes/inventory.routes.js';
import auditRoutes from './audit_logs/routes/audit.routes.js';
import authRoutes from './auth/routes/auth.routes.js';

const app = express();
const PostgresSessionStore = connectPgSimple(session);
const sessionStore = new PostgresSessionStore({ pool, createTableIfMissing: true });

app.disable('x-powered-by');
app.use(requestContext);
app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, false);
        if (config.allowedOrigins.has(origin)) return callback(null, origin);

        const error = new Error('Untrusted CORS origin.');
        error.status = 403;
        return callback(error);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Origin', 'Idempotency-Key'],
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.use(session({
    name: 'bean.sid',
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60,
        sameSite: config.cookieSameSite,
        secure: config.cookieSecure,
    },
}));

app.use(requireTrustedOrigin);
app.use('/auth/', authRoutes);
app.use('/inventory/', inventoryRoutes);
app.use('/audit/', auditRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

let server;

const startServer = async () => {
    let databaseClient;
    let startupFailed = false;
    try {
        databaseClient = await pool.connect();
        const result = await databaseClient.query(`
            SELECT current_database() AS database,
                   current_user AS role,
                   inet_server_addr()::text AS server_address
        `);
        const connectionHost = config.database.connectionString
            ? new URL(config.database.connectionString).hostname
            : config.database.host;
        const tlsEnabled = databaseClient.connection.stream.encrypted === true;
        console.log('[BREADCRUMB][DATABASE_CONNECTED]', JSON.stringify({
            database: result.rows[0].database,
            role: result.rows[0].role,
            host: connectionHost,
            serverAddress: result.rows[0].server_address,
            tls: tlsEnabled,
        }));

        server = app.listen(config.port, config.host, () => {
            console.log(`[SERVER] Listening on ${config.host}:${config.port} (${config.nodeEnv}).`);
        });
    } catch (error) {
        console.error('[BREADCRUMB][DATABASE_CONNECTION_FAILED]', JSON.stringify({
            code: error.code ?? 'UNKNOWN',
            message: error.message,
        }));
        startupFailed = true;
    } finally {
        databaseClient?.release();
    }
    if (startupFailed) {
        await pool.end().catch(() => {});
        process.exitCode = 1;
    }
};

void startServer();

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SERVER] ${signal} received; shutting down.`);

    let failed = false;
    try {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    } catch {
        failed = true;
    }
    try {
        await sessionStore.close();
    } catch {
        failed = true;
    }
    try {
        await pool.end();
    } catch {
        failed = true;
    }

    if (failed) {
        console.error('[SERVER] Graceful shutdown encountered a resource close failure.');
        process.exitCode = 1;
    } else {
        console.log('[SERVER] Shutdown complete.');
        process.exitCode = 0;
    }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

export { app, server };
