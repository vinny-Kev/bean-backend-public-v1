// Shared building blocks for the endpoint specification. Everything here mirrors behavior
// verified in the backend source; nothing is aspirational.

export const paging = [
    { name: 'page', type: 'integer', desc: '1-based page number. Mutually exclusive with `offset`.', example: '1' },
    { name: 'limit', type: 'integer', desc: 'Page size, 1 to 20 (default 20 once any paging parameter is sent).', example: '20' },
    { name: 'offset', type: 'integer', desc: 'Zero-based row offset. Mutually exclusive with `page`.', example: '0' },
];

export const pagination = { page: 1, limit: 20, offset: 0, total: 1, totalPages: 1, hasMore: false };

export const timeRange = [
    { name: 'from', type: 'ISO-8601 timestamp', desc: 'Inclusive lower bound.', example: '2026-10-01T00:00:00Z' },
    { name: 'to', type: 'ISO-8601 timestamp', desc: 'Inclusive upper bound; must not be earlier than `from`.', example: '2026-10-28T00:00:00Z' },
];

const uuid = '3f0c2c1e-5b8a-4f43-9a55-0c2e7c9d1a10';

// Error bodies, by the module that produces them (the project has two established shapes).
export const err = {
    unauthenticated: { status: 401, note: 'No valid session.', body: { message: 'Unauthorized. Please authenticate.' } },
    sessionExpired: { status: 401, note: 'Session older than 6 hours (absolute lifetime).', body: { message: 'Session expired. Please log in again.' } },
    permission: {
        status: 403, note: 'The account role lacks a required permission.',
        body: { message: 'Forbidden: You do not have the required permissions.', error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden: You do not have the required permissions.' } },
    },
    origin: { status: 403, note: 'Unsafe method without a trusted `Origin` header.', body: { error: { code: 'ORIGIN_DENIED', message: 'Request origin is not allowed.', requestId: uuid } } },
    internal: { status: 500, note: 'Unexpected server error (details are never returned).', body: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.', requestId: uuid } } },
    plain: (status, message, note) => ({ status, note, body: { message } }),
    coded: (status, code, message, note) => ({ status, note, body: { error: { code, message } } }),
    ticket: (status, message, note, code = { 400: 'VALIDATION_ERROR', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' }[status]) => ({
        status, note, body: { error: { code, message, requestId: uuid } },
    }),
    badPaging: { status: 400, note: 'Invalid pagination parameters.', body: { message: 'The limit must be an integer between 1 and 20.' } },
};

export const tenantParam = (name = 'tenant_id') => ({
    name, type: 'positive integer', desc: 'Tenant ID. Only selects the tenant; authority comes from the caller\'s `tenant_members` role.', example: '{{tenantId}}',
});
export const integrationParam = {
    name: 'integration_id', type: 'positive integer', desc: 'Integrated app ID. The tenant is derived from the integration row, never supplied by the client.', example: '{{integrationId}}',
};
export const ticketParam = { name: 'ticketId', type: 'positive integer (bigint)', desc: 'Ticket ID within the tenant.', example: '{{ticketId}}' };

export const adminAuth = (permission) => ({
    session: true, permission, tenantRole: 'owner or admin of the tenant that owns the integration (re-checked inside the transaction)',
});
export const memberAuth = (permission) => ({ session: true, permission, tenantRole: 'any member of the tenant' });
