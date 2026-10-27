import bcrypt from 'bcrypt';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { pool } from '../../db/pool.js';
import { recordIntegrationDiagnostic } from '../services/integrationDiagnostics.js';
import { resolveIntegrationHandlerKind } from '../services/integrationHandlerRegistry.js';
import { compareToPattern, parsePositiveId } from '../../util/validations.js';

const denied = (req, res) => {
    void recordIntegrationDiagnostic({ req, outcome: 'unauthorized', errorCode: 'INTEGRATION_AUTH_FAILED',
        errorSummary: 'Integration credentials are invalid.', httpStatus: 401 });
    return res.status(401).json({ error: { code: 'INTEGRATION_AUTH_FAILED', message: 'Integration credentials are invalid.' } });
};

const isValidTimestamp = (value) => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value ?? '');
    if (!parts) return false;
    const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = parts;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days
        && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
        && (!offsetHour || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
        && Number.isFinite(Date.parse(value));
};

const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: false,
    validateFormats: true, addUsedSchema: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats(ajv);
const schemaCache = new Map();
const maxSchemaCacheEntries = 100;
const draft07 = 'http://json-schema.org/draft-07/schema#';

export const requireIntegrationOrigin = async (req, res, next) => {
    const rawId = req.params.integration_id;
    const appKey = req.get('x-bean-app-key');
    const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(req.get('authorization') ?? '');
    if (!parsePositiveId(rawId)
        || typeof appKey !== 'string' || appKey.length < 8 || appKey.length > 100 || !match) return denied(req, res);

    try {
        const result = await pool.query(
            `SELECT ia.id, ia.tenant_id, ia.app_key, ia.credential_hash, ia.status, t.status AS tenant_status
             FROM integrated_apps ia JOIN tenants t ON t.id = ia.tenant_id
             WHERE ia.id = $1`, [rawId],
        );
        const integration = result.rows[0];
        if (!integration || integration.status !== 'active' || integration.tenant_status !== 'active'
            || integration.app_key !== appKey
            || typeof integration.credential_hash !== 'string'
            || !await bcrypt.compare(match[1], integration.credential_hash)) return denied(req, res);
        req.integration = { id: integration.id, tenantId: integration.tenant_id };
        return next();
    } catch (error) {
        return next(error);
    }
};

const checkSchemaComplexity = (schema) => {
    let nodes = 0;
    const visit = (value, depth) => {
        nodes += 1;
        if (nodes > 2000 || depth > 20) throw new Error('Registered event schema exceeds complexity limits.');
        if (value && typeof value === 'object') {
            for (const child of Object.values(value)) visit(child, depth + 1);
        }
    };
    visit(schema, 0);
};

export const validateAgainstSchema = (value, schema, path = 'payload') => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Registered event schema is invalid.');
    if (schema.$schema && schema.$schema !== draft07) throw new Error('Only JSON Schema Draft 7 is supported.');
    let schemaText;
    try { schemaText = JSON.stringify(schema); } catch { throw new Error('Registered event schema is invalid.'); }
    if (Buffer.byteLength(schemaText, 'utf8') > 32 * 1024) throw new Error('Registered event schema exceeds size limits.');
    checkSchemaComplexity(schema);

    let validate = schemaCache.get(schemaText);
    if (!validate) {
        try { validate = ajv.compile(schema); }
        catch { throw new Error('Registered event schema is invalid.'); }
        if (schemaCache.size >= maxSchemaCacheEntries) schemaCache.delete(schemaCache.keys().next().value);
        schemaCache.set(schemaText, validate);
    }
    if (validate(value)) return null;
    const issue = validate.errors?.[0];
    const location = issue?.instancePath ? `${path}${issue.instancePath}` : path;
    return `${location} ${issue?.message ?? 'is invalid.'}`;
};

export const validateBusinessEvent = (eventType, payload) => {
    if (eventType === 'transaction.completed') {
        const allowed = new Set(['externalTransactionId', 'productId', 'quantity', 'status', 'saleAmount', 'currency', 'externalUserId']);
        if (Object.keys(payload).some((key) => !allowed.has(key))) return 'Sale payload contains unsupported fields.';
        if (typeof payload.externalTransactionId !== 'string' || !payload.externalTransactionId.trim()
            || payload.externalTransactionId.length > 255 || typeof payload.productId !== 'string'
            || !compareToPattern(payload.productId, 'product_id')
            || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 2147483647
            || payload.status !== 'completed'
            || !compareToPattern(String(payload.saleAmount), 'money_amount')
            || typeof payload.currency !== 'string' || !compareToPattern(payload.currency, 'currency_code')
            || typeof payload.externalUserId !== 'string' || !payload.externalUserId.trim()
            || payload.externalUserId.length > 255) return 'Sale payload contains invalid business fields.';
    }
    if (eventType === 'inventory.adjusted') {
        const allowed = new Set(['productId', 'quantity', 'adjustment']);
        if (Object.keys(payload).some((key) => !allowed.has(key))) return 'Inventory adjustment payload contains unsupported fields.';
        if (typeof payload.productId !== 'string' || !compareToPattern(payload.productId, 'product_id')
            || !Number.isSafeInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 2147483647
            || !['increase', 'decrease', 'set'].includes(payload.adjustment)) return 'Inventory adjustment payload is invalid.';
    }
    return null;
};

export const validateAndAuthorizeIntegrationEvent = async (req, res, next) => {
    const event = req.body;
    const reject = async (status, code, message) => {
        await recordIntegrationDiagnostic({ req, integration: req.integration, event,
            outcome: 'invalid', errorCode: code, errorSummary: message, httpStatus: status });
        return res.status(status).json({ error: { code, message } });
    };
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return reject(400, 'INVALID_EVENT', 'Event must be a JSON object.');
    }
    if (Object.keys(event).some((key) => !['eventId', 'eventType', 'occurredAt', 'payload', 'correlationId'].includes(key))) {
        return reject(400, 'INVALID_EVENT', 'Event contains unsupported fields.');
    }
    if (typeof event.eventId !== 'string' || !compareToPattern(event.eventId, 'event_id')
        || typeof event.eventType !== 'string' || !compareToPattern(event.eventType, 'event_type')
        || typeof event.occurredAt !== 'string' || !isValidTimestamp(event.occurredAt)
        || Date.parse(event.occurredAt) > Date.now() + 5 * 60 * 1000
        || (event.correlationId !== undefined && (typeof event.correlationId !== 'string' || !compareToPattern(event.correlationId, 'event_id')))
        || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        return reject(400, 'INVALID_EVENT', 'Event envelope is invalid.');
    }
    try {
        const result = await pool.query(
            `SELECT er.event_type, er.payload_schema
             FROM event_registry er
             JOIN integrated_app_event_subscriptions s
               ON s.event_type = er.event_type
              AND s.integrated_app_id = $1
              AND s.tenant_id = $2
              AND s.is_enabled = true
             WHERE er.event_type = $3 AND er.is_active = true`,
            [req.integration.id, req.integration.tenantId, event.eventType],
        );
        const registered = result.rows[0];
        if (!registered) return reject(422, 'EVENT_NOT_SUBSCRIBED', 'Event type is not registered and enabled for this integration.');
        const issue = validateAgainstSchema(event.payload, registered.payload_schema);
        if (issue) return reject(400, 'INVALID_EVENT_PAYLOAD', issue);
        const handlerResult = await pool.query(
            `SELECT handler_key FROM event_registry WHERE event_type=$1 AND is_active=true`, [event.eventType],
        );
        const handlerKind = resolveIntegrationHandlerKind(handlerResult.rows[0]?.handler_key);
        if (!handlerKind) {
            return reject(422, 'UNSUPPORTED_HANDLER', 'This registered event type has no supported handler.');
        }
        const businessIssue = handlerKind === 'sale'
            ? validateBusinessEvent('transaction.completed', event.payload)
            : handlerKind === 'inventory_adjustment' ? validateBusinessEvent('inventory.adjusted', event.payload) : null;
        if (businessIssue) return reject(400, 'INVALID_EVENT_PAYLOAD', businessIssue);
        req.integrationEvent = {
            eventId: event.eventId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            correlationId: event.correlationId ?? req.requestId,
            payload: event.payload,
        };
        return next();
    } catch (error) {
        return next(error);
    }
};
