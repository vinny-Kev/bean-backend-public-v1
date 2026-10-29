import { createHmac } from 'node:crypto';
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

const parseIntegerList = (name, value, { min, max }) => {
    const values = value.split(',').map((item) => parseInteger(name, item.trim(), { min, max }));
    if (values.length < 1 || values.some((item) => item === null)) {
        throw new Error(`${name} must be a comma-separated list of integers between ${min} and ${max}.`);
    }
    return Object.freeze(values);
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

// Identity and mail. SMTP settings are only read (and required) for the smtp transport.
const parseBoolean = (name, value, fallback) => {
    if (value === undefined || value === '') return fallback;
    if (!['true', 'false'].includes(value.toLowerCase())) throw new Error(`${name} must be true or false.`);
    return value.toLowerCase() === 'true';
};
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const mailTransport = (process.env.MAIL_TRANSPORT ?? (nodeEnv === 'production' ? 'smtp' : nodeEnv === 'test' ? 'capture' : 'outbox')).toLowerCase();
if (!['smtp', 'outbox', 'capture'].includes(mailTransport)) {
    throw new Error('MAIL_TRANSPORT must be smtp, outbox (development: writes messages to .mail-outbox/) or capture (tests).');
}
if (nodeEnv === 'production' && mailTransport !== 'smtp') {
    throw new Error('MAIL_TRANSPORT must be smtp in production.');
}
let mail = { transport: mailTransport };
const mailFromAddress = process.env.MAIL_FROM_ADDRESS?.trim() || 'no-reply@bean.invalid';
if (mailTransport === 'smtp' || process.env.MAIL_FROM_ADDRESS) {
    if (!emailPattern.test(mailFromAddress)) throw new Error('MAIL_FROM_ADDRESS must be a valid email address.');
}
mail = { ...mail, fromAddress: mailFromAddress, fromName: process.env.MAIL_FROM_NAME?.trim() || 'Bean' };
if (mailTransport === 'smtp') {
    const smtpUser = process.env.SMTP_USER?.trim();
    const smtpPassword = process.env.SMTP_PASSWORD;
    if (Boolean(smtpUser) !== Boolean(smtpPassword)) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together.');
    const smtpPort = parseInteger('SMTP_PORT', process.env.SMTP_PORT ?? '587', { min: 1, max: 65535 });
    mail = {
        ...mail,
        host: required('SMTP_HOST'),
        port: smtpPort,
        // true = implicit TLS (usually port 465); false = STARTTLS is required, never plaintext.
        secure: parseBoolean('SMTP_SECURE', process.env.SMTP_SECURE, smtpPort === 465),
        ...(smtpUser && { user: smtpUser, password: smtpPassword }),
    };
    required('MAIL_FROM_ADDRESS');
}

// Links in emails are built only from this trusted origin, never from request headers.
const appBaseUrl = (process.env.APP_BASE_URL?.trim() || allowedOrigins[0] || '').replace(/\/+$/, '');
if (appBaseUrl && !allowedOrigins.includes(appBaseUrl)) {
    throw new Error('APP_BASE_URL must be one of the APP_ORIGINS entries.');
}
if (nodeEnv === 'production' && !appBaseUrl) throw new Error('APP_BASE_URL is required in production.');

const otpPepper = process.env.OTP_PEPPER?.trim()
    || createHmac('sha256', sessionSecret).update('bean:identity-pepper:v1').digest('hex');
if (otpPepper.length < 32) throw new Error('OTP_PEPPER must be at least 32 characters long.');

const loginStepUp = (process.env.LOGIN_STEP_UP ?? 'new-device').toLowerCase();
if (!['new-device', 'off'].includes(loginStepUp)) throw new Error('LOGIN_STEP_UP must be new-device or off.');

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
    mail: Object.freeze(mail),
    appBaseUrl,
    otpPepper,
    loginStepUp,
    cookieSameSite: sameSite,
    cookieSecure: nodeEnv === 'production',
    allowedOrigins: new Set(allowedOrigins),
    integrationWorkerIntervalMs: parseInteger('INTEGRATION_WORKER_INTERVAL_MS', process.env.INTEGRATION_WORKER_INTERVAL_MS ?? '300000', { min: 1000, max: 86400000 }),
    integrationWorkerBatchSize: parseInteger('INTEGRATION_WORKER_BATCH_SIZE', process.env.INTEGRATION_WORKER_BATCH_SIZE ?? '100', { min: 1, max: 1000 }),
    integrationMaxAttempts: parseInteger('INTEGRATION_MAX_ATTEMPTS', process.env.INTEGRATION_MAX_ATTEMPTS ?? '5', { min: 1, max: 20 }),
    integrationLeaseMs: parseInteger('INTEGRATION_LEASE_MS', process.env.INTEGRATION_LEASE_MS ?? '300000', { min: 10000, max: 3600000 }),
    integrationRetryDelaysMs: parseIntegerList('INTEGRATION_RETRY_DELAYS_MS', process.env.INTEGRATION_RETRY_DELAYS_MS ?? '60000,300000,900000,3600000', { min: 1000, max: 86400000 }),
    integrationRetentionIntervalMs: parseInteger('INTEGRATION_RETENTION_INTERVAL_MS', process.env.INTEGRATION_RETENTION_INTERVAL_MS ?? '86400000', { min: 60000, max: 604800000 }),
    integrationRetentionBatchSize: parseInteger('INTEGRATION_RETENTION_BATCH_SIZE', process.env.INTEGRATION_RETENTION_BATCH_SIZE ?? '500', { min: 1, max: 5000 }),
    integrationEventRetentionDays: parseInteger('INTEGRATION_EVENT_RETENTION_DAYS', process.env.INTEGRATION_EVENT_RETENTION_DAYS ?? '90', { min: 1, max: 3650 }),
    integrationAttemptRetentionDays: parseInteger('INTEGRATION_ATTEMPT_RETENTION_DAYS', process.env.INTEGRATION_ATTEMPT_RETENTION_DAYS ?? '180', { min: 1, max: 3650 }),
    integrationDiagnosticRetentionDays: parseInteger('INTEGRATION_DIAGNOSTIC_RETENTION_DAYS', process.env.INTEGRATION_DIAGNOSTIC_RETENTION_DAYS ?? '90', { min: 1, max: 3650 }),
    analyticsOutboxRetentionDays: parseInteger('ANALYTICS_OUTBOX_RETENTION_DAYS', process.env.ANALYTICS_OUTBOX_RETENTION_DAYS ?? '90', { min: 1, max: 3650 }),
    database: Object.freeze(database),
});
