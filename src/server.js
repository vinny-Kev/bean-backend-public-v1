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

const server = app.listen(config.port, config.host, () => {
    console.log(`[SERVER] Listening on ${config.host}:${config.port} (${config.nodeEnv}).`);
});

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SERVER] ${signal} received; shutting down.`);

    let failed = false;
    try {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
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
