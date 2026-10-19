import 'dotenv/config';

const required = (name) => {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
};

const parseInteger = (name, value, { min, max }) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return parsed;
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
}

const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32 || sessionSecret.toLowerCase().startsWith('replace_with')) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
}

const sameSite = (process.env.COOKIE_SAME_SITE ?? 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(sameSite)) {
    throw new Error('COOKIE_SAME_SITE must be Lax, Strict, or None.');
}

const allowedOrigins = (process.env.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

for (const origin of allowedOrigins) {
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error('APP_ORIGINS must contain comma-separated origin URLs.');
    }
    if (origin === '*' || parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('APP_ORIGINS entries must be exact http(s) origins; wildcard and paths are not allowed.');
    }
}

if (nodeEnv === 'production' && allowedOrigins.length === 0) {
    throw new Error('APP_ORIGINS must include at least one approved frontend origin in production.');
}
if (sameSite === 'none' && nodeEnv !== 'production') {
    throw new Error('COOKIE_SAME_SITE=None requires NODE_ENV=production and HTTPS.');
}

const databaseUrl = process.env.DATABASE_URL?.trim();
let database;
if (databaseUrl) {
    let parsedDatabaseUrl;
    try {
        parsedDatabaseUrl = new URL(databaseUrl);
    } catch {
        throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)
        || !parsedDatabaseUrl.hostname
        || !parsedDatabaseUrl.pathname.slice(1)) {
        throw new Error('DATABASE_URL must include a PostgreSQL scheme, host, and database name.');
    }
    // pg-connection-string currently treats `require` as `verify-full` but warns
    // that this alias will change in a future major release. Be explicit.
    if (['prefer', 'require', 'verify-ca'].includes(parsedDatabaseUrl.searchParams.get('sslmode'))) {
        parsedDatabaseUrl.searchParams.set('sslmode', 'verify-full');
    }
    database = {
        connectionString: parsedDatabaseUrl.toString(),
        ssl: { rejectUnauthorized: true },
    };
} else {
    database = {
        host: required('DB_HOST'),
        port: parseInteger('DB_PORT', process.env.DB_PORT ?? '5432', { min: 1, max: 65535 }),
        database: required('DB_NAME'),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
    };
}

export const config = Object.freeze({
    nodeEnv,
    host: process.env.HOST?.trim() || '127.0.0.1',
    port: parseInteger('PORT', process.env.PORT ?? '3000', { min: 1, max: 65535 }),
    sessionSecret,
    cookieSameSite: sameSite,
    cookieSecure: nodeEnv === 'production',
    allowedOrigins: new Set(allowedOrigins),
    database: Object.freeze(database),
});
