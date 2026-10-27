import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { count, one, resetSchema, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer } from './support/testServer.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL tenant, member, and inventory isolation tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

let api;
let close;

// Fixtures: tenant 1 = owner 1, member 2, admin 6 (staff role, no TENANTS_CREATE);
// tenant 2 = owner 3; user 4 = dev, no tenant; user 5 = no role.
const members = async (tenantId) => (await pool.query(
    'SELECT user_id::int AS id, membership_role AS role FROM tenant_members WHERE tenant_id=$1 ORDER BY user_id', [tenantId],
)).rows.map((row) => `${row.id}:${row.role}`);

describe('tenant onboarding, member management, and tenant isolation against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ api, close } = await startTestServer());
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('tenant creation requires the account-level TENANTS_CREATE permission, not a tenant role', async () => {
        const body = { name: 'Side Org', slug: 'side-org' };
        assert.equal((await api('POST', '/tenants', { body })).status, 401);
        assert.equal((await api('POST', '/tenants', { user: 5, body })).status, 403, 'an account with no role');
        const admin = await api('POST', '/tenants', { user: 6, body });
        assert.equal(admin.status, 403, 'being a tenant admin does not grant tenant creation');
        assert.equal(await count(`SELECT COUNT(*) FROM tenants WHERE slug='side-org'`), 0);

        const me = await api('GET', '/auth/me', { user: 6 });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.permissions.includes('TENANTS_CREATE'), false);
        assert.ok((await api('GET', '/auth/me', { user: 2 })).body.user.permissions.includes('TENANTS_CREATE'));
        assert.deepEqual((await api('GET', '/auth/me', { user: 5 })).body.user.permissions, []);

        const created = await api('POST', '/tenants', { user: 2, body });
        assert.equal(created.status, 201, 'a plain member of another tenant may create one with the account permission');
        assert.deepEqual(await members(created.body.data.id), ['2:owner']);
    });

    test('tenant creation is atomic: a failure after the tenant insert leaves no tenant behind', async () => {
        await pool.query(`CREATE OR REPLACE FUNCTION test_fail_membership() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
            CREATE TRIGGER test_fail_membership BEFORE INSERT ON tenant_members FOR EACH ROW EXECUTE FUNCTION test_fail_membership();`);
        try {
            const response = await api('POST', '/tenants', { user: 4, body: { name: 'Broken', slug: 'broken-org' } });
            assert.equal(response.status, 500);
            assert.equal(JSON.stringify(response.body).includes('simulated'), false, 'internal errors are not exposed');
            assert.equal(await count(`SELECT COUNT(*) FROM tenants WHERE slug='broken-org'`), 0);
            assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='CREATE TENANT'`), 0);
        } finally {
            await pool.query('DROP TRIGGER test_fail_membership ON tenant_members; DROP FUNCTION test_fail_membership();');
        }
    });

    test('tenant detail and membership lists are visible only to members', async () => {
        const detail = await api('GET', '/tenants/1', { user: 2 });
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.membershipRole, 'member');
        assert.equal(detail.body.data.memberCount, 3);
        assert.equal((await api('GET', '/tenants/1', { user: 3 })).status, 404);
        assert.equal((await api('GET', '/tenants/abc', { user: 1 })).status, 400);
        await pool.query(`UPDATE tenants SET status='deleted' WHERE id=2`);
        assert.equal((await api('GET', '/tenants/2', { user: 3 })).status, 404, 'deleted tenants are not retrievable');

        const list = await api('GET', '/tenants/1/members', { user: 2 });
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.data.map((m) => `${m.userId}:${m.membershipRole}`), ['1:owner', '6:admin', '2:member'], 'owners, then admins, then members');
        assert.deepEqual(Object.keys(list.body.data[0]).sort(), ['accountStatus', 'email', 'joinedAt', 'membershipRole', 'userId', 'username']);
        assert.equal(JSON.stringify(list.body).includes('password'), false);
        const page = await api('GET', '/tenants/1/members?page=2&limit=2', { user: 2 });
        assert.deepEqual(page.body.data.map((m) => m.userId), ['2']);
        assert.equal(page.body.pagination.total, 3);
        assert.equal((await api('GET', '/tenants/1/members', { user: 3 })).status, 404);
        assert.equal((await api('GET', '/tenants/1/members/6', { user: 2 })).body.data.membershipRole, 'admin');
        assert.equal((await api('GET', '/tenants/1/members/3', { user: 2 })).status, 404, 'a user outside the tenant is not a member');
    });

    test('adding members: owners grant any role, admins add plain members, members cannot add', async () => {
        const added = await api('POST', '/tenants/1/members', { user: 1, body: { email: 'FOUNDER@new.test', role: 'admin' } });
        assert.equal(added.status, 201);
        assert.equal(added.body.data.userId, '4');
        assert.equal(added.body.data.membershipRole, 'admin');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='ADD TENANT MEMBER' AND user_id=1 AND record_id=4
            AND new_data->>'membershipRole'='admin' AND new_data->>'tenantId'='1'`), 1);

        assert.equal((await api('POST', '/tenants/1/members', { user: 6, body: { username: 'norole' } })).status, 201, 'admin adds a member');
        const escalate = await api('POST', '/tenants/1/members', { user: 6, body: { username: 'globexowner', role: 'admin' } });
        assert.equal(escalate.status, 403);
        assert.equal(escalate.body.error.code, 'OWNER_REQUIRED');
        assert.equal((await api('POST', '/tenants/1/members', { user: 2, body: { username: 'globexowner' } })).status, 403, 'members cannot add');
        assert.equal((await api('POST', '/tenants/1/members', { user: 3, body: { username: 'globexowner' } })).status, 404, 'outsiders cannot add');

        assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { email: 'member@acme.test' } })).body.error.code, 'ALREADY_MEMBER');
        assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { email: 'nobody@acme.test' } })).body.error.code, 'USER_NOT_FOUND');
        await pool.query('UPDATE users SET is_disabled=true WHERE id=3');
        assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { username: 'globexowner' } })).status, 404, 'disabled accounts cannot be added');
        for (const body of [{}, { email: 'a@b.co', username: 'abc' }, { email: 'not-an-email' }, { username: 'x' },
            { username: 'founder', role: 'superuser' }, { username: 'founder', tenantId: 2 }]) {
            assert.equal((await api('POST', '/tenants/1/members', { user: 1, body })).status, 400, JSON.stringify(body));
        }
        assert.deepEqual(await members(1), ['1:owner', '2:member', '4:admin', '5:member', '6:admin']);
    });

    test('a failed audit write rolls back the membership change', async () => {
        await pool.query(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN IF NEW.action='ADD TENANT MEMBER' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_audit();`);
        try {
            assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { username: 'founder' } })).status, 500);
            assert.equal(await count('SELECT COUNT(*) FROM tenant_members WHERE tenant_id=1 AND user_id=4'), 0);
        } finally {
            await pool.query('DROP TRIGGER test_fail_audit ON audit_logs; DROP FUNCTION test_fail_audit();');
        }
    });

    test('role changes: only owners change roles, nobody changes their own, and the last owner is protected', async () => {
        assert.equal((await api('PATCH', '/tenants/1/members/2', { user: 2, body: { role: 'owner' } })).body.error.code, 'CANNOT_CHANGE_OWN_ROLE');
        assert.equal((await api('PATCH', '/tenants/1/members/2', { user: 6, body: { role: 'admin' } })).body.error.code, 'OWNER_REQUIRED');
        assert.equal((await api('PATCH', '/tenants/1/members/6', { user: 6, body: { role: 'owner' } })).body.error.code, 'CANNOT_CHANGE_OWN_ROLE');
        assert.equal((await api('PATCH', '/tenants/1/members/1', { user: 1, body: { role: 'member' } })).body.error.code, 'CANNOT_CHANGE_OWN_ROLE');
        assert.equal((await api('PATCH', '/tenants/1/members/3', { user: 1, body: { role: 'admin' } })).status, 404);
        assert.equal((await api('PATCH', '/tenants/1/members/2', { user: 1, body: { role: 'root' } })).status, 400);
        assert.equal((await api('PATCH', '/tenants/1/members/2', { user: 3, body: { role: 'owner' } })).status, 404);

        // Ownership transfer: promote, then the new owner demotes the old one.
        const promoted = await api('PATCH', '/tenants/1/members/2', { user: 1, body: { role: 'owner' } });
        assert.equal(promoted.status, 200);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='UPDATE TENANT MEMBER ROLE' AND record_id=2
            AND old_data->>'membershipRole'='member' AND new_data->>'membershipRole'='owner'`), 1);
        assert.equal((await api('PATCH', '/tenants/1/members/1', { user: 2, body: { role: 'member' } })).status, 200);
        assert.deepEqual(await members(1), ['1:member', '2:owner', '6:admin']);
        assert.equal((await api('DELETE', '/tenants/1/members/2', { user: 2 })).body.error.code, 'LAST_OWNER', 'the sole owner cannot leave');
        assert.equal((await api('PATCH', '/tenants/1/members/2', { user: 1, body: { role: 'admin' } })).status, 403, 'demoted owners lost authority');
        assert.equal((await api('PATCH', '/tenants/1/members/6', { user: 2, body: { role: 'admin' } })).body.message, 'Role unchanged.');
    });

    test('removal rules, leaving, linked records, and concurrent owner removal', async () => {
        assert.equal((await api('DELETE', '/tenants/1/members/1', { user: 6 })).body.error.code, 'OWNER_REQUIRED', 'admins cannot remove owners');
        assert.equal((await api('DELETE', '/tenants/1/members/6', { user: 2 })).status, 403, 'members cannot remove others');
        await pool.query(`INSERT INTO integration_user_mappings (tenant_id, integrated_app_id, external_user_id, user_id) VALUES (1, 1, 'cashier-2', 2)`);
        const linked = await api('DELETE', '/tenants/1/members/2', { user: 6 });
        assert.equal(linked.status, 409);
        assert.equal(linked.body.error.code, 'MEMBER_HAS_LINKED_RECORDS');
        await pool.query(`DELETE FROM integration_user_mappings WHERE external_user_id='cashier-2'`);
        assert.equal((await api('DELETE', '/tenants/1/members/2', { user: 6 })).status, 200, 'admins remove plain members');
        assert.equal((await api('DELETE', '/tenants/1/members/6', { user: 6 })).body.message, 'You left the tenant.');
        assert.deepEqual(await members(1), ['1:owner']);
        assert.equal((await api('DELETE', '/tenants/1/members/1', { user: 1 })).body.error.code, 'LAST_OWNER');
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='REMOVE TENANT MEMBER'`), 2);

        // Two owners removing each other at the same time must not leave the tenant ownerless.
        assert.equal((await api('POST', '/tenants/2/members', { user: 3, body: { username: 'founder', role: 'owner' } })).status, 201);
        const race = await Promise.all([api('DELETE', '/tenants/2/members/4', { user: 3 }), api('DELETE', '/tenants/2/members/3', { user: 4 })]);
        // The tenant lock serializes them: the second request re-reads its role under the lock,
        // finds it was already removed, and gets 404 (or 409 LAST_OWNER if it still were an owner).
        assert.equal(race.filter((r) => r.status === 200).length, 1);
        assert.ok(race.some((r) => [404, 409].includes(r.status)));
        assert.equal(await count(`SELECT COUNT(*) FROM tenant_members WHERE tenant_id=2 AND membership_role='owner'`), 1);

        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=1`);
        assert.equal((await api('POST', '/tenants/1/members', { user: 1, body: { username: 'founder' } })).body.error.code, 'TENANT_INACTIVE');
    });

    test('integration investigation and settings endpoints stay inside the caller\'s tenant', async () => {
        const event = (await pool.query(`INSERT INTO integration_events (tenant_id, integrated_app_id, event_id, event_type, payload, occurred_at, status)
            VALUES (1, 1, 'scoped-1', 'transaction.completed', '{}', NOW(), 'failed') RETURNING id`)).rows[0];
        await pool.query(`INSERT INTO integration_event_diagnostics (tenant_id, integrated_app_id, event_id, outcome, http_status)
            VALUES (1, 1, 'scoped-1', 'accepted', 202)`);

        assert.equal((await api('GET', '/integrations/events?tenantId=1', { user: 1 })).body.pagination.total, 1);
        assert.equal((await api('GET', '/integrations/events?tenantId=1', { user: 3 })).status, 403, 'another tenant\'s owner');
        assert.equal((await api('GET', '/integrations/events?tenantId=2', { user: 3 })).body.pagination.total, 0);
        assert.equal((await api('GET', `/integrations/events/${event.id}?tenantId=2`, { user: 3 })).status, 404, 'an event ID from another tenant');
        assert.equal((await api('GET', `/integrations/events/${event.id}?tenantId=1`, { user: 2 })).status, 200);
        assert.equal((await api('GET', '/integrations/diagnostics?tenantId=1', { user: 3 })).status, 403);
        assert.equal((await api('GET', '/integrations/diagnostics?tenantId=2&integrationId=1', { user: 3 })).body.pagination.total, 0);
        assert.equal((await api('POST', `/integrations/events/${event.id}/retry`, { user: 3, body: { tenantId: '2', reason: 'Trying to retry a foreign event' } })).status, 409,
            'retry is scoped to the caller\'s tenant, so a foreign event is never eligible');
        assert.equal((await api('GET', '/integrations/tenants/1/settings', { user: 3 })).status, 403);
        assert.equal((await api('PUT', '/integrations/tenants/1/settings/inventory-policy', { user: 3,
            body: { inventoryShortagePolicy: 'allow_negative_inventory' } })).status, 403);
        assert.equal((await api('POST', '/integrations/1/credentials/rotate', { user: 3, body: { tenantId: '1' } })).status, 404,
            'credential rotation requires membership in the integration\'s tenant');
        assert.equal((await api('POST', '/integrations/1/credentials/rotate', { user: 3, body: { tenantId: '2' } })).status, 404,
            'a tenantId the caller owns does not unlock another tenant\'s integration');
        assert.equal(await count(`SELECT COUNT(*) FROM integration_events WHERE id=$1 AND status='failed'`, [event.id]), 1);
    });

    test('inventory reads and writes are confined to the caller\'s tenant', async () => {
        await pool.query(`INSERT INTO inventory (tenant_id, name, sku, quantity) VALUES (NULL, 'Legacy', 'LEGACY-1', 3)`);
        const mine = await api('GET', '/inventory/tenants/1/items', { user: 2 });
        assert.equal(mine.status, 200);
        assert.deepEqual(mine.body.data.map((item) => [item.id, item.sku, item.quantity]), [['1', 'BEAN-42', 10]],
            'only tenant 1 stock; not tenant 2\'s BEAN-42, not tenantless rows');
        assert.equal((await api('GET', '/inventory/tenants/1/items?page=1&limit=5', { user: 2 })).body.pagination.total, 1);
        assert.equal((await api('GET', '/inventory/tenants/2/items', { user: 2 })).status, 404, 'cannot read another tenant');
        assert.equal((await api('GET', '/inventory/tenants/1/items', { user: 5 })).status, 403, 'no INVENTORY_READ permission');
        assert.equal((await api('GET', '/inventory/tenants/1/items')).status, 401);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='READ INVENTORY' AND new_data->>'tenantId'='1'`), 2);

        const item = { name: 'Coffee beans', sku: 'cof-1', quantity: 5 };
        const created = await api('POST', '/inventory/tenants/1/items', { user: 2, body: item });
        assert.equal(created.status, 200);
        assert.equal((await one(`SELECT tenant_id FROM inventory WHERE sku='COF-1'`)).tenant_id, '1');
        assert.equal((await api('POST', '/inventory/tenants/1/items', { user: 2, body: item })).status, 409, 'duplicate SKU within a tenant');
        assert.equal((await api('POST', '/inventory/tenants/2/items', { user: 3, body: item })).status, 200, 'the same SKU in another tenant');
        assert.equal((await api('POST', '/inventory/tenants/2/items', { user: 2, body: item })).status, 404, 'cannot write another tenant');

        const update = { name: 'Hijacked', sku: 'BEAN-42', quantity: 0, unit: 'unit' };
        assert.equal((await api('PUT', '/inventory/tenants/2/items/1', { user: 3, body: update })).status, 404,
            'tenant 2 cannot update tenant 1\'s item through its own tenant path');
        assert.equal((await api('PUT', '/inventory/tenants/1/items/1', { user: 3, body: update })).status, 404, 'or through tenant 1\'s path');
        assert.equal((await one('SELECT name, quantity FROM inventory WHERE id=1')).quantity, 10);
        assert.equal((await api('PUT', '/inventory/tenants/1/items/1', { user: 2, body: { ...update, name: 'Bean bag XL', quantity: 12 } })).status, 200);
        assert.equal((await one('SELECT quantity FROM inventory WHERE id=1')).quantity, 12);
        assert.equal((await api('PUT', '/inventory/tenants/1/items/007', { user: 2, body: update })).status, 400);

        for (const [method, path] of [['GET', '/inventory/all'], ['POST', '/inventory/add'], ['PUT', '/inventory/update/1']]) {
            assert.equal((await api(method, path, { user: 1, ...(method !== 'GET' && { body: {} }) })).status, 404, `${path} no longer exists`);
        }
        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=1`);
        assert.equal((await api('POST', '/inventory/tenants/1/items', { user: 2, body: { ...item, sku: 'COF-2' } })).status, 409);
        assert.equal((await api('GET', '/inventory/tenants/1/items', { user: 2 })).status, 200, 'suspended tenants stay readable');
    });
});
