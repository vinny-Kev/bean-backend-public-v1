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
import integrationRoutes from './integrations/routes/integration.routes.js';
import tenantRoutes from './tenants/routes/tenant.routes.js';
import { startIntegrationEventWorker } from './integrations/services/integrationEventWorker.js';
import { startIntegrationRetentionWorker } from './integrations/services/integrationRetentionService.js';
import ticketRoutes from './ticketing/routes/ticket.routes.js';
import healthRoutes from './health/routes/health.routes.js';
import onboardingRoutes from './auth/routes/onboarding.routes.js';
import invitationRoutes from './invitations/routes/invitation.routes.js';
const app = express();
const PostgresSessionStore = connectPgSimple(session);
const sessionStore = new PostgresSessionStore({ pool, createTableIfMissing: true });

app.disable('x-powered-by');
app.use(requestContext);
app.use(helmet());
// Public probes: before CORS, sessions and the origin check.
app.use('/health', healthRoutes);
app.use(cors({
    // Integration events are server-to-server; integration app URLs must not
    // become credentialed CORS origins for session-authenticated routes.
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
app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/integrations\/[1-9]\d*\/events\/?$/.test(req.path)) return next();
    return express.json({ limit: '100kb' })(req, res, next);
});
app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/integrations\/[1-9]\d*\/events\/?$/.test(req.path)) return next();
    return express.urlencoded({ extended: false, limit: '10kb' })(req, res, next);
});

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

app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/integrations\/[1-9]\d*\/events\/?$/.test(req.path)) return next();
    return requireTrustedOrigin(req, res, next);
});
app.use('/auth/', authRoutes);
app.use('/inventory/', inventoryRoutes);
app.use('/audit/', auditRoutes);
app.use('/integrations/', integrationRoutes);
app.use('/tenants/', tenantRoutes);
app.use('/invitations/', invitationRoutes);
app.use('/onboarding/', onboardingRoutes);
app.use('/ticketing/', ticketRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

let server;
let stopIntegrationWorker;
let stopIntegrationRetentionWorker;

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
        console.log("\x1b[34m%s\x1b[0m", '[BREADCRUMB][DATABASE_CONNECTED]', JSON.stringify({
            database: result.rows[0].database,
            role: result.rows[0].role,
            host: connectionHost,
            serverAddress: result.rows[0].server_address,
            tls: tlsEnabled,
        }));

        server = app.listen(config.port, config.host, () => {
            const today = new Date();
            console.log("\x1b[34m%s\x1b[0m", `[SERVER] Listening on ${config.host}:${config.port} (${config.nodeEnv}).`);
            console.log("\x1b[31m%s\x1b[0m", `
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠋⠋⠋⠉⠙⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠇⠃⠀⠀⠀⠀⠈⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣀⣀⣀⣀⡀⠀⠀⠘⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⣀⡤⠔⣒⣊⠭⣭⣍⣒⣒⠒⠒⠒⠒⠚⡛⣛⣛⣠⡶⠶⣤⣤⡄⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⣠⢔⣫⣴⡾⠿⣒⣉⠭⠤⠤⠒⠒⠒⠒⠒⠒⠒⠓⠒⠒⠂⠤⠭⢍⣒⡪⠵⣊⠭⣒⠤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⢀⢾⣷⠟⣫⠕⠊⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠓⠻⠷⣯⣪⣕⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⣾⡿⣣⠎⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⢷⣽⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠹⣧⠃⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣴⣶⣾⣿⣿⣿⣿⣿⣿⣿⣷⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢈⣟⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠘⢧⡀⠀⠀⠀⠀⠀⠀⢠⣾⡟⢿⣿⣿⡏⠈⢿⣿⣿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⠀⠀⣠⣾⢿⣧⣍⠳⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠙⠢⢄⡀⠀⠀⠀⣿⡟⡇⠘⣿⣧⠁⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⢀⣠⠤⡞⢿⡉⠴⠽⡏⠓⣬⠳⡀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠈⠉⠐⢺⣿⣯⡆⠀⣿⣿⡇⣀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣷⠉⠁⠀⠀⠈⣎⣳⣷⢿⠃⠀⠈⣧⠙⠦⣀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⡷⠆⡿⠿⣿⠛⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠀⠀⣅⡤⢄⣹⠀⠀⠀⠘⢧⡀⠈⠉⠓⠚⢉⡽
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⣿⣷⣿⡃⠀⢞⣷⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀⠀⠀⠈⡇⢸⠀⠀⠀⠀⠀⠀⠙⠲⠴⠖⠚⠉⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⣿⣿⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⢀⠙⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⣿⣷⠀⠀⠀⡜⢠⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⢎⣉⣉⣉⣉⣉⡠⠎⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠚⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⢋⡤⠊⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⡠⠋⡴⠋⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀Bean Enterprise Management System⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⡞⢠⠏⠀⠀⠀⣼⣿⣿⣿⣿⡿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀Server Start Date⠀${today.toLocaleDateString()}⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠳⣌⠓⠿⣽⣯⠹⢿⠁⠛⢉⣁⠹⡸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠈⠑⠒⠺⢿⣤⣼⣄⣴⣿⣾⣠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠚⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⢿⣿⣿⣃⣀⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠁⡞⠉⠁⠀⠀⠀⠀⠀⠙⣆⠀⠀⠀⠀⠀⣀⣄⡀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢰⢀⢀⡠⠔⠊⠉⢧⠀⠀⠘⢦⠀⠀⢀⢾⠁⠈⠹⡆⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢈⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣤⠗⠋⠀⠀⠀⠀⠈⠳⣄⠀⢈⠧⣄⡘⡦⠀⠀⢰⠃⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡴⠉⠀⠈⠙⢻⡿⣿⣿⣿⣿⠿⠿⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠈⠑⣇⡀⡨⡳⠃⠀⢸⠃⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⠀⠀⢸⠊⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⡵⠡⠀⡴⠃⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⡤⠞⠁⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠀⠀⡘⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡏⠑⠒⢹⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⢞⣇⡖⠒⠟⣧⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⡔⢯⡫⠷⢋⣬⠿⠙⠓⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠣⣤⣍⣳⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
`);
        });
        stopIntegrationWorker = startIntegrationEventWorker();
        stopIntegrationRetentionWorker = startIntegrationRetentionWorker();
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
    stopIntegrationWorker?.();
    stopIntegrationRetentionWorker?.();
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
        sessionStore.close();
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
