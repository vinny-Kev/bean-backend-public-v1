// Run: node --experimental-test-module-mocks --test src/ticketing/ticketing.test.mjs
// This test uses an isolated HTTP app and a fake pool; it never writes to PostgreSQL.
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let role = 'member';
let failAudit = false;
const queries = [];
const fakeRow = {
    id: '7', tenant_id: '2', ticket_number: '13', title: 'Printer broken',
    description: null, ticket_type: 'support', status: 'open', priority: 'medium',
    requester_user_id: '3', inbox_id: null, assigned_to_user_id: null,
    created_by_user_id: '3', parent_ticket_id: null, due_at: null,
    acknowledged_at: null, resolved_at: null, closed_at: null,
    created_at: new Date(), updated_at: new Date(),
};
const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM tenant_members tm JOIN tenants t')) {
        return { rows: role ? [{ membership_role: role }] : [] };
    }
    if (sql.includes('FROM tenant_members tm JOIN users u')) return { rows: [{}] };
    if (sql.includes('SELECT * FROM tickets')) return { rows: [fakeRow] };
    if (sql.includes('INSERT INTO tickets')) return { rows: [fakeRow] };
    if (sql.includes('INSERT INTO audit_logs') && failAudit) throw new Error('audit write failed');
    return { rows: [] };
};
const pool = { query, connect: async () => ({ query, release() {} }) };
mock.module('../db/pool.js', { exports: { pool } });
mock.module('../middleware/auth/sessionAuthMiddleware.js', {
    exports: { sessionAuthMiddleware: (req, _res, next) => {
        req.user = { id: '3' };
        next();
    } },
});
const { default: routes } = await import('./routes/ticket.routes.js');

let server;
let base;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/ticketing', routes);
    app.use((_error, _req, res, _next) => res.status(500).json({ message: 'Internal error' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { role = 'member'; failAudit = false; queries.length = 0; });

const postTicket = (body) => fetch(`${base}/ticketing/tenants/2/tickets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('tenant membership is required before any ticket query', async () => {
    role = null;
    const response = await fetch(`${base}/ticketing/tenants/2/tickets`);
    assert.equal(response.status, 403);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /FROM tenant_members tm JOIN tenants t/);
});

test('member cannot create a ticket on behalf of another user', async () => {
    const response = await postTicket({ title: 'Printer broken', requesterUserId: '4' });
    assert.equal(response.status, 403);
    assert.equal(queries.length, 1);
});

test('manager ticket creation commits activity and audit in one transaction', async () => {
    role = 'admin';
    const response = await postTicket({ title: 'Printer broken' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.title, 'Printer broken');
    assert.deepEqual(queries.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' ')), [
        'SELECT tm.membership_role FROM', 'BEGIN', 'SELECT 1 FROM',
        'INSERT INTO tickets', 'INSERT INTO ticket_activity', 'INSERT INTO audit_logs', 'COMMIT',
    ]);
});

test('failed audit rolls back the ticket and history', async () => {
    role = 'admin';
    failAudit = true;
    const response = await postTicket({ title: 'Printer broken' });
    assert.equal(response.status, 500);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.equal(queries.some(({ sql }) => sql === 'COMMIT'), false);
});

test('a verifier cannot verify their own work', async () => {
    role = 'admin';
    const response = await fetch(`${base}/ticketing/tenants/2/tickets/7/verifications`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contributorUserId: '3', verifiedPoints: 2 }),
    });
    assert.equal(response.status, 403);
    assert.equal(queries.length, 1);
});

test('requester cannot see internal comments', async () => {
    const response = await fetch(`${base}/ticketing/tenants/2/tickets/7/comments`);
    assert.equal(response.status, 200);
    const comments = queries.find(({ sql }) => sql.includes('FROM ticket_comments'));
    assert.equal(comments.params[2], false);
    assert.match(comments.sql, /is_internal = false/);
});

test('unassigned member cannot change status', async () => {
    const response = await fetch(`${base}/ticketing/tenants/2/tickets/7/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(response.status, 403);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('member cannot view another employee summary without HR permission', async () => {
    const response = await fetch(`${base}/ticketing/tenants/2/work-summary/4`);
    assert.equal(response.status, 403);
    assert.equal(queries.some(({ sql }) => sql.includes('FROM ticket_work_verifications')), false);
});
