import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { integrationTest as test } from './integrationTestReporter.js';
import { resetSchema, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';

// Behavioral checks of partial indexes that ORM/console schema exports drop.
describe('baseline schema behavior', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => { await resetSchema(); await seedFixtures(); });
    after(() => pool.end());

    test('ticket assignments allow history but only one active primary and one active row per user', async () => {
        const ticket = (await pool.query(`INSERT INTO tickets (tenant_id, title) VALUES (1, 'Assignment rules') RETURNING id`)).rows[0].id;
        const assign = (userId, primary) => pool.query(
            'INSERT INTO ticket_assignments (tenant_id, ticket_id, user_id, is_primary) VALUES (1,$1,$2,$3) RETURNING id', [ticket, userId, primary]);

        const first = (await assign(1, true)).rows[0].id;
        await assert.rejects(assign(2, true), { constraint: 'uq_ticket_primary_assignment' });
        await assert.rejects(assign(1, false), { constraint: 'uq_ticket_active_assignment' });
        await assign(2, false);

        await pool.query('UPDATE ticket_assignments SET unassigned_at=NOW() WHERE id=$1', [first]);
        await assign(1, true);
        await pool.query(`UPDATE ticket_assignments SET unassigned_at=NOW() WHERE ticket_id=$1 AND user_id=1 AND unassigned_at IS NULL`, [ticket]);
        await assign(1, false);
        const rows = (await pool.query('SELECT COUNT(*)::int AS n FROM ticket_assignments WHERE ticket_id=$1', [ticket])).rows[0].n;
        assert.equal(rows, 4, 'unassigned rows remain as history');
    });

    test('deleting an inbox clears only inbox_id on its tickets (column-list ON DELETE SET NULL)', async () => {
        const inbox = (await pool.query(`INSERT INTO ticket_inboxes (tenant_id, name, email) VALUES (1, 'Support', 'help@acme.test') RETURNING id`)).rows[0].id;
        const ticket = (await pool.query(`INSERT INTO tickets (tenant_id, title, inbox_id) VALUES (1, 'Inbox rule', $1) RETURNING id`, [inbox])).rows[0].id;
        await pool.query('DELETE FROM ticket_inboxes WHERE id=$1', [inbox]);
        const row = (await pool.query('SELECT tenant_id, inbox_id FROM tickets WHERE id=$1', [ticket])).rows[0];
        assert.equal(row.tenant_id, '1');
        assert.equal(row.inbox_id, null);
    });

    test('inventory SKU uniqueness is per tenant and ignores tenantless legacy rows', async () => {
        await assert.rejects(pool.query(`INSERT INTO inventory (tenant_id, name, sku) VALUES (1, 'Dup', 'BEAN-42')`), { constraint: 'uq_inventory_tenant_sku' });
        await pool.query(`INSERT INTO inventory (tenant_id, name, sku) VALUES (NULL, 'Legacy A', 'LEGACY'), (NULL, 'Legacy B', 'LEGACY')`);
    });
});
