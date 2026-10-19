import express from 'express';
import 'dotenv/config';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';

import { pool } from './db/pool.js';
import { requireTrustedOrigin } from './middleware/auth/originMiddleware.js';
import inventoryRoutes from './inventory/routes/inventory.routes.js';
import authRoutes from './auth/routes/auth.routes.js';

const app = express();
const PORT = 3000;

const PostgresSessionStore = connectPgSimple(session);

export const allowedOrigins = new Set(
    (process.env.APP_ORIGINS ?? '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
)

const sessionSecret = process.env.SESSION_SECRET;
if(!sessionSecret || sessionSecret.length < 32) {
    throw new Error(
        'SESSION_SECRET must be configured and be at least 32 characters long.'
    )
}

app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
            return callback(null, true);
        }

        if (allowedOrigins.has(origin)) {
            return callback(null, true);
        }

        return callback(new Error('CORS Origin Denied: Untrusted origin.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Origin'],
}));
app.use(express.json({ limit: '100kb'}));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.use(session({
    name: 'bean.sid',
    store: new PostgresSessionStore({
        pool,
        createTableIfMissing: true,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
    }
}));

app.use(requireTrustedOrigin);
app.use("/auth/", authRoutes);
app.use("/inventory/", inventoryRoutes);

app.listen(PORT, () => {
    console.log(`[SERVER] Start Process - Server is running on port ${PORT}`);
});



