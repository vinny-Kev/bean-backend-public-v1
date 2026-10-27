import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../../../config.js';
import { pool } from '../../../db/pool.js';
import { requireTrustedOrigin } from '../../../middleware/auth/originMiddleware.js';
import { errorHandler, notFoundHandler, requestContext } from '../../../middleware/errorMiddleware.js';
import authRoutes from '../../../auth/routes/auth.routes.js';
import inventoryRoutes from '../../../inventory/routes/inventory.routes.js';
import integrationRoutes from '../../routes/integration.routes.js';
import tenantRoutes from '../../../tenants/routes/tenant.routes.js';

// The first configured APP_ORIGINS entry; unsafe requests must carry it (CSRF origin check).
export const trustedOrigin = [...config.allowedOrigins][0] ?? null;

// Test-only stand-in for express-session: the real sessionAuthMiddleware and
// requirePermission still run and reload the user and role from the database.
const fakeSession = (req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { userId: Number(userId), authenticatedAt: Date.now() } : {};
    next();
};

const isEventIngestion = (req) => req.method === 'POST' && /\/events\/?$/.test(req.path);

// Mirrors server.js ordering for the routes under test, without starting workers.
// realSessions: true uses the production session stack (PostgreSQL store, cookies, origin check).
export const startTestServer = async ({ realSessions = false } = {}) => {
    const app = express();
    app.use(requestContext);
    app.use((req, res, next) => (isEventIngestion(req) ? next() : express.json({ limit: '100kb' })(req, res, next)));
    if (realSessions) {
        const PostgresSessionStore = connectPgSimple(session);
        app.use(session({ name: 'bean.sid', store: new PostgresSessionStore({ pool }), secret: config.sessionSecret,
            resave: false, saveUninitialized: false, rolling: true,
            cookie: { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: config.cookieSameSite, secure: config.cookieSecure } }));
        app.use((req, res, next) => (isEventIngestion(req) ? next() : requireTrustedOrigin(req, res, next)));
    } else {
        app.use(fakeSession);
    }
    app.use('/auth/', authRoutes);
    app.use('/inventory/', inventoryRoutes);
    app.use('/integrations/', integrationRoutes);
    app.use('/tenants/', tenantRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // A client keeps its own cookie jar (real sessions) and sends the trusted Origin on unsafe methods.
    const client = () => {
        const cookies = new Map();
        return async (method, path, { user, body, origin = trustedOrigin } = {}) => {
            const response = await fetch(`${baseUrl}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json',
                    ...(user && { 'x-test-user': String(user) }),
                    ...(origin && !['GET', 'HEAD'].includes(method) && { Origin: origin }),
                    ...(cookies.size && { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }) },
                ...(body !== undefined && { body: JSON.stringify(body) }),
            });
            for (const header of response.headers.getSetCookie()) {
                const [pair, ...attributes] = header.split(';');
                const [name, value] = pair.split('=');
                const expired = attributes.some((attribute) => /expires=Thu, 01 Jan 1970/i.test(attribute));
                if (expired || !value) cookies.delete(name.trim()); else cookies.set(name.trim(), value);
            }
            const text = await response.text();
            return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
        };
    };
    const api = client();
    const sendEvent = async (appId, appKey, secret, event) => {
        const response = await fetch(`${baseUrl}/integrations/${appId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bean-App-Key': appKey, Authorization: `Bearer ${secret}` },
            body: JSON.stringify(event),
        });
        return { status: response.status, body: await response.json() };
    };
    return { baseUrl, api, client, sendEvent, close: () => new Promise((resolve) => server.close(resolve)) };
};
