import express from 'express';
import 'dotenv/config';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

import { pool } from './db/pool.js';
import inventoryRoutes from './inventory/routes/inventory.routes.js';
import authRoutes from './auth/routes/auth.routes.js';

const app = express();
const PORT = 3000;

const PostgresSessionStore = connectPgSimple(session);

app.use(express.json());
app.use(session({
    store: new PostgresSessionStore({
        pool,
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
    }
}))

app.use("/auth/", authRoutes);
app.use("/inventory/", inventoryRoutes);

app.listen(PORT, () => {
    console.log(`[SERVER] Start Process - Server is running on port ${PORT}`);
});



