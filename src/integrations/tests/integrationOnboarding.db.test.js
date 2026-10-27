import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import bcrypt from 'bcrypt';
import { pool } from '../../db/pool.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { count, one, resetSchema, saleEvent, seedFixtures, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer } from './support/testServer.js';

if (testDatabaseSkipReason) {
    reportBlockedIntegrationCheck('PostgreSQL onboarding and lifecycle tests', 'a local *_test database is configured',
        `skipped: ${testDatabaseSkipReason}`);
}

let api;
let sendEvent;
let close;

const lifecycleActions = async (appId) => (await pool.query(
    'SELECT action, outcome, actor_user_id FROM integration_lifecycle_activity WHERE integrated_app_id=$1 ORDER BY id', [appId],
)).rows.map((row) => `${row.action}:${row.outcome}`);

const onboardTenant = async (user = 4, slug = 'new-org') => {
    const created = await api('POST', '/tenants', { user, body: { name: 'New Org', slug } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.data;
};

const registerApp = async (tenantId, user = 4) => {
    const created = await api('POST', `/integrations/tenants/${tenantId}/apps`, { user,
        body: { name: 'Storefront', description: 'Primary shop', appUrl: 'https://shop.example.test' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.data;
};

describe('tenant onboarding and integration lifecycle against PostgreSQL', { skip: testDatabaseSkipReason, concurrency: false }, () => {
    before(async () => {
        await resetSchema();
        ({ api, sendEvent, close } = await startTestServer());
    });
    after(async () => {
        await close?.();
        await pool.end();
    });
    beforeEach(seedFixtures);

    test('an authenticated user creates a tenant and becomes its owner, with an audit record', async () => {
        assert.equal((await api('POST', '/tenants', { body: { name: 'X', slug: 'xyz' } })).status, 401);
        assert.equal((await api('POST', '/tenants', { user: 4, body: { name: 'X', slug: 'Not A Slug' } })).status, 400);
        assert.equal((await api('POST', '/tenants', { user: 4, body: { name: 'X', slug: 'xyz', ownerUserId: 1 } })).status, 400);

        const tenant = await onboardTenant(4);
        assert.equal(tenant.membershipRole, 'owner');
        assert.equal(tenant.status, 'active');
        assert.equal((await one('SELECT membership_role FROM tenant_members WHERE tenant_id=$1 AND user_id=4', [tenant.id])).membership_role, 'owner');
        assert.equal(await count('SELECT COUNT(*) FROM tenant_members WHERE tenant_id=$1', [tenant.id]), 1);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='CREATE TENANT' AND user_id=4 AND record_id=$1`, [tenant.id]), 1);

        const duplicate = await api('POST', '/tenants', { user: 3, body: { name: 'Other', slug: 'new-org' } });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.body.error.code, 'TENANT_SLUG_TAKEN');

        const mine = await api('GET', '/tenants', { user: 4 });
        assert.deepEqual(mine.body.data.map((t) => t.slug), ['new-org']);
        assert.deepEqual((await api('GET', '/tenants', { user: 3 })).body.data.map((t) => t.slug), ['globex']);
    });

    test('integration registration requires tenant admin membership and never trusts a client tenant ID', async () => {
        const body = { name: 'Storefront' };
        assert.equal((await api('POST', '/integrations/tenants/1/apps', { body })).status, 401);
        assert.equal((await api('POST', '/integrations/tenants/1/apps', { user: 5, body })).status, 403, 'no global permission');
        const outsider = await api('POST', '/integrations/tenants/1/apps', { user: 4, body });
        assert.equal(outsider.status, 404, 'non-members cannot discover or use another tenant');
        const member = await api('POST', '/integrations/tenants/1/apps', { user: 2, body });
        assert.equal(member.status, 403);
        assert.equal(member.body.error.code, 'TENANT_ADMIN_REQUIRED');
        assert.equal((await api('POST', '/integrations/tenants/1/apps', { user: 1, body: { ...body, tenantId: 2 } })).status, 400);
        assert.equal((await api('POST', '/integrations/tenants/1/apps', { user: 1, body: { ...body, appUrl: 'javascript:alert(1)' } })).status, 400);
        assert.equal(await count('SELECT COUNT(*) FROM integrated_apps'), 2);

        await pool.query(`UPDATE tenants SET status='suspended' WHERE id=1`);
        assert.equal((await api('POST', '/integrations/tenants/1/apps', { user: 1, body })).status, 409);
    });

    test('a registered integration gets a one-time credential stored only as a bcrypt hash', async () => {
        const tenant = await onboardTenant();
        const app = await registerApp(tenant.id);
        assert.equal(app.status, 'pending');
        assert.equal(app.tenantId, tenant.id);
        assert.match(app.appKey, /^bean_[A-Za-z0-9_-]{24}$/);
        assert.match(app.credential, /^[A-Za-z0-9_-]{64}$/);

        const stored = await one('SELECT * FROM integrated_apps WHERE id=$1', [app.id]);
        assert.notEqual(stored.credential_hash, app.credential);
        assert.equal(await bcrypt.compare(app.credential, stored.credential_hash), true);
        assert.equal(stored.created_by_user_id, '4');

        const detail = await api('GET', `/integrations/${app.id}`, { user: 4 });
        assert.equal(detail.status, 200);
        assert.equal(JSON.stringify(detail.body).includes(app.credential), false);
        assert.equal(JSON.stringify(detail.body).includes(stored.credential_hash), false);
        assert.equal(detail.body.data.credentialConfigured, true);
        assert.deepEqual(detail.body.data.readiness.checks,
            { tenantActive: true, credentialConfigured: true, supportedSubscriptionEnabled: false });

        const trail = JSON.stringify([(await pool.query('SELECT * FROM audit_logs')).rows,
            (await pool.query('SELECT * FROM integration_lifecycle_activity')).rows]);
        assert.equal(trail.includes(app.credential), false);
        assert.equal(trail.includes(stored.credential_hash), false);
        assert.deepEqual(await lifecycleActions(app.id), ['integration.created:succeeded']);
        assert.equal(await count(`SELECT COUNT(*) FROM audit_logs WHERE action='CREATE INTEGRATION' AND record_id=$1`, [app.id]), 1);
    });

    test('app-scoped operations are invisible to other tenants and forbidden to non-admin members', async () => {
        for (const [method, path, body] of [['GET', '/integrations/1'], ['POST', '/integrations/1/suspend'],
            ['POST', '/integrations/1/disconnect'], ['PUT', '/integrations/1/subscriptions', { eventTypes: [] }],
            ['PUT', '/integrations/1/user-mappings', { externalUserId: 'x', userId: 3 }]]) {
            const outsider = await api(method, path, { user: 3, body });
            assert.equal(outsider.status, 404, `${method} ${path} as another tenant's owner`);
        }
        assert.equal((await api('POST', '/integrations/1/suspend', { user: 2 })).status, 403);
        assert.equal((await api('GET', '/integrations/1', { user: 2 })).status, 200, 'members may read');
        assert.equal((await one('SELECT status FROM integrated_apps WHERE id=1')).status, 'active');
        assert.equal(await count('SELECT COUNT(*) FROM integration_lifecycle_activity'), 0);
    });

    test('full onboarding: configure, validate, activate, ingest, and process an event in the new tenant', async () => {
        const tenant = await onboardTenant();
        const app = await registerApp(tenant.id);
        const event = saleEvent({ eventId: 'first-sale' }, { externalUserId: 'cashier-7', productId: 'NEW-1' });

        const early = await sendEvent(app.id, app.appKey, app.credential, event);
        assert.equal(early.status, 401, 'a pending integration cannot deliver events');

        const notReady = await api('POST', `/integrations/${app.id}/activate`, { user: 4 });
        assert.equal(notReady.status, 409);
        assert.equal(notReady.body.error.code, 'INTEGRATION_NOT_READY');
        assert.equal(notReady.body.error.checks.supportedSubscriptionEnabled, false);
        assert.equal((await one('SELECT status FROM integrated_apps WHERE id=$1', [app.id])).status, 'pending');

        const unsupported = await api('PUT', `/integrations/${app.id}/subscriptions`, { user: 4,
            body: { eventTypes: ['transaction.completed', 'transaction.refunded'] } });
        assert.equal(unsupported.status, 422);
        assert.deepEqual(unsupported.body.error.eventTypes, ['transaction.refunded']);
        assert.equal(await count('SELECT COUNT(*) FROM integrated_app_event_subscriptions WHERE integrated_app_id=$1', [app.id]), 0);

        assert.equal((await api('PUT', `/integrations/${app.id}/subscriptions`, { user: 4,
            body: { eventTypes: ['transaction.completed'] } })).status, 200);
        const foreignUser = await api('PUT', `/integrations/${app.id}/user-mappings`, { user: 4,
            body: { externalUserId: 'cashier-7', userId: 1 } });
        assert.equal(foreignUser.status, 422, 'cannot map an external user to someone outside the tenant');
        assert.equal((await api('PUT', `/integrations/${app.id}/user-mappings`, { user: 4,
            body: { externalUserId: 'cashier-7', userId: 4 } })).status, 200);
        // No tenant-scoped inventory API exists yet, so stock is seeded directly.
        await pool.query(`INSERT INTO inventory (tenant_id, name, sku, quantity) VALUES ($1, 'New item', 'NEW-1', 20)`, [tenant.id]);

        const activated = await api('POST', `/integrations/${app.id}/activate`, { user: 4 });
        assert.equal(activated.status, 200, JSON.stringify(activated.body));
        assert.equal(activated.body.data.status, 'active');
        assert.equal(activated.body.data.lastEventAt, null, 'activation is not event activity');

        const accepted = await sendEvent(app.id, app.appKey, app.credential, event);
        assert.equal(accepted.status, 202);
        assert.notEqual((await one('SELECT last_event_at FROM integrated_apps WHERE id=$1', [app.id])).last_event_at, null);
        assert.equal(await processIntegrationEventBatch(), 1);

        const sale = await one('SELECT * FROM sales_transactions WHERE integrated_app_id=$1', [app.id]);
        assert.equal(sale.tenant_id, String(tenant.id));
        assert.equal((await one('SELECT quantity FROM inventory WHERE tenant_id=$1', [tenant.id])).quantity, 18);
        assert.equal((await one(`SELECT status FROM integration_events WHERE event_id='first-sale'`)).status, 'processed');
        assert.equal(await count('SELECT COUNT(*) FROM analytics_outbox WHERE tenant_id=$1', [tenant.id]), 1);
        assert.equal(await count('SELECT COUNT(*) FROM sales_commissions WHERE tenant_id=$1', [tenant.id]), 0, 'no commission rule configured');

        assert.deepEqual(await lifecycleActions(app.id), ['integration.created:succeeded', 'integration.activated:failed',
            'subscriptions.updated:succeeded', 'user_mapping.updated:succeeded', 'integration.activated:succeeded']);
        for (const action of ['UPDATE INTEGRATION SUBSCRIPTIONS', 'UPDATE INTEGRATION USER MAPPING', 'ACTIVATE INTEGRATION']) {
            assert.equal(await count('SELECT COUNT(*) FROM audit_logs WHERE action=$1 AND user_id=4', [action]), 1, action);
        }
    });

    test('disabling a subscription stops new deliveries of that event type', async () => {
        const live = saleEvent({ eventId: 'before' });
        assert.equal((await sendEvent(1, 'acme-store-key', 'acme-integration-secret-0123456789abcdefghij', live)).status, 202);
        assert.equal((await api('PUT', '/integrations/1/subscriptions', { user: 1, body: { eventTypes: ['inventory.adjusted'] } })).status, 200);
        const blocked = await sendEvent(1, 'acme-store-key', 'acme-integration-secret-0123456789abcdefghij',
            saleEvent({ eventId: 'after' }, { externalTransactionId: 'order-2' }));
        assert.equal(blocked.status, 422);
        assert.equal(blocked.body.error.code, 'EVENT_NOT_SUBSCRIBED');
        assert.equal(await count(`SELECT COUNT(*) FROM integrated_app_event_subscriptions WHERE integrated_app_id=1 AND is_enabled`), 1);
    });

    test('suspend, reactivate, rotate, and disconnect enforce credentials and lifecycle rules', async () => {
        const tenant = await onboardTenant();
        const app = await registerApp(tenant.id);
        await api('PUT', `/integrations/${app.id}/subscriptions`, { user: 4, body: { eventTypes: ['inventory.adjusted'] } });
        assert.equal((await api('POST', `/integrations/${app.id}/activate`, { user: 4 })).status, 200);
        assert.equal((await api('POST', `/integrations/${app.id}/activate`, { user: 4 })).status, 409, 'already active');
        const adjust = (eventId) => ({ eventId, eventType: 'inventory.adjusted', occurredAt: new Date().toISOString(),
            payload: { productId: 'NEW-1', quantity: 1, adjustment: 'increase' } });

        assert.equal((await api('POST', `/integrations/${app.id}/suspend`, { user: 4 })).status, 200);
        assert.equal((await sendEvent(app.id, app.appKey, app.credential, adjust('while-suspended'))).status, 401);
        assert.equal((await api('POST', `/integrations/${app.id}/suspend`, { user: 4 })).status, 409);
        assert.equal((await api('POST', `/integrations/${app.id}/activate`, { user: 4 })).status, 200);

        const rotated = await api('POST', `/integrations/${app.id}/credentials/rotate`, { user: 4, body: { tenantId: String(tenant.id) } });
        assert.equal(rotated.status, 200);
        const newSecret = rotated.body.data.credential;
        assert.equal((await sendEvent(app.id, app.appKey, app.credential, adjust('old-secret'))).status, 401);
        assert.equal((await sendEvent(app.id, app.appKey, newSecret, adjust('new-secret'))).status, 202);

        const disconnected = await api('POST', `/integrations/${app.id}/disconnect`, { user: 4 });
        assert.equal(disconnected.status, 200);
        assert.equal(disconnected.body.data.status, 'revoked');
        assert.equal(disconnected.body.data.credentialConfigured, false);
        const stored = await one('SELECT credential_hash, status FROM integrated_apps WHERE id=$1', [app.id]);
        assert.equal(stored.credential_hash, null);
        assert.equal(await count('SELECT COUNT(*) FROM integrated_app_event_subscriptions WHERE integrated_app_id=$1 AND is_enabled', [app.id]), 0);
        assert.equal((await sendEvent(app.id, app.appKey, newSecret, adjust('after-disconnect'))).status, 401);
        for (const path of ['activate', 'suspend', 'disconnect']) {
            assert.equal((await api('POST', `/integrations/${app.id}/${path}`, { user: 4 })).status, 409, path);
        }
        assert.equal((await api('PUT', `/integrations/${app.id}/subscriptions`, { user: 4, body: { eventTypes: ['inventory.adjusted'] } })).status, 409);
        assert.equal((await api('POST', `/integrations/${app.id}/credentials/rotate`, { user: 4, body: { tenantId: String(tenant.id) } })).status, 409);

        assert.deepEqual(await lifecycleActions(app.id), ['integration.created:succeeded', 'subscriptions.updated:succeeded',
            'integration.activated:succeeded', 'integration.suspended:succeeded', 'integration.activated:succeeded',
            'credential.rotated:succeeded', 'integration.disconnected:succeeded']);
        // The event accepted before disconnection was authenticated, so it is still processed (and fails only on its business rule).
        await processIntegrationEventBatch();
        assert.equal((await one(`SELECT error_code FROM integration_events WHERE event_id='new-secret'`)).error_code, 'INVENTORY_UNAVAILABLE');
    });
});
