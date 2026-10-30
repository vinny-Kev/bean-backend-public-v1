import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { resetSchema, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer, trustedOrigin } from './support/testServer.js';

// Executes tests/requestly/bean-backend-e2e.postman_collection.json in order against a
// real-session test server and checks every response against the status in its description.
// The manual steps the collection asks a human to do (setup step 4, copying IDs) are done here.
const collectionPath = new URL('../../../tests/requestly/bean-backend-e2e.postman_collection.json', import.meta.url);
const skip = testDatabaseSkipReason || (!trustedOrigin && 'APP_ORIGINS must contain at least one origin.');
if (skip) reportBlockedIntegrationCheck('Requestly collection end-to-end run', 'a local *_test database and APP_ORIGINS', `skipped: ${skip}`);

const captures = {
    'Create tenant': (body, vars) => { vars.tenant_id = body.data.id; },
    'Create inventory item': (body, vars) => { vars.item_id = body.data.id; },
    'Register integration': (body, vars) => { vars.integration_id = body.data.id; vars.app_key = body.data.appKey; vars.app_secret = body.data.credential; },
    'Rotate credential': (body, vars) => { vars.old_app_secret = vars.app_secret; vars.app_secret = body.data.credential; },
};

describe('Requestly end-to-end collection', { skip, concurrency: false }, () => {
    let server;
    before(async () => {
        await resetSchema();
        // A fresh database has no roles; create the dev role the collection's setup step relies on.
        await pool.query(`INSERT INTO roles (name) VALUES ('dev') ON CONFLICT DO NOTHING;
            INSERT INTO permissions (name) VALUES ('INTEGRATIONS_READ'), ('INVENTORY_READ'), ('INVENTORY_CREATE'), ('INVENTORY_UPDATE')
            ON CONFLICT DO NOTHING;
            INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p
                WHERE r.name='dev' AND p.name NOT LIKE 'PLATFORM\\_%'
            ON CONFLICT DO NOTHING;`);
        server = await startTestServer({ realSessions: true });
    });
    after(async () => {
        await server?.close();
        await pool.end();
    });

    test('every request in the collection returns its documented status', async () => {
        const collection = JSON.parse(readFileSync(collectionPath, 'utf8'));
        const vars = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]));
        vars.origin = trustedOrigin;
        const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
        const api = server.client();
        const results = [];

        // The manual walkthrough lives under one parent folder; the scripted onboarding folder
        // is covered by requestlyOnboarding.db.test.js.
        const walkthrough = collection.item.find((item) => item.name === '99 Full E2E walkthrough (manual steps)').item;
        for (const folder of walkthrough) {
            if (folder.name.startsWith('06')) vars.event_occurred_at = new Date().toISOString();
            if (folder.name.startsWith('07')) await processIntegrationEventBatch();
            for (const item of folder.item) {
                const { method, url, header = [], body, description } = item.request;
                const expected = Number(/^Expected: (\d{3})/.exec(description)[1]);
                const headers = Object.fromEntries(header.filter((h) => !h.disabled).map((h) => [h.key, fill(h.value)]));
                const path = fill(url.raw).replace(vars.base_url, '');
                // Session requests go through the cookie-keeping client so login/logout carry over;
                // ingestion requests are sent as-is with their integration credentials.
                let final;
                if (headers.Authorization) {
                    const response = await fetch(`${server.baseUrl}${path}`, { method, headers, body: body && fill(body.raw) });
                    final = { status: response.status, body: await response.json() };
                } else {
                    let parsed;
                    try { parsed = body ? JSON.parse(fill(body.raw)) : undefined; } catch (error) {
                        throw new Error(`${folder.name} > ${item.name}: ${error.message} :: ${results.join(' | ')}`);
                    }
                    final = await api(method, path, { body: parsed, origin: headers.Origin ?? null });
                }
                results.push(`${final.status === expected ? 'ok  ' : 'FAIL'} ${final.status} (expected ${expected}) ${folder.name} > ${item.name}`);
                if (final.status === expected && captures[item.name]) captures[item.name](final.body, vars);
            }
            if (folder.name.startsWith('01')) {
                // Signup now leaves accounts unverified. The identity flow (code by email) is covered by
                // src/identity/identity.db.test.js; here the accounts are verified directly so the walkthrough can continue.
                await pool.query(`UPDATE users SET email_verified_at = now() WHERE email = ANY($1)`, [[vars.owner_email, vars.member_email, vars.outsider_email]]);
                await pool.query(`UPDATE users SET role_id=(SELECT id FROM roles WHERE name='dev') WHERE email = ANY($1)`,
                    [[vars.owner_email, vars.outsider_email]]);
                const ids = Object.fromEntries((await pool.query('SELECT email, id FROM users WHERE email = ANY($1)', [[vars.owner_email, vars.member_email]])).rows.map((r) => [r.email, r.id]));
                vars.owner_user_id = ids[vars.owner_email];
                vars.member_user_id = ids[vars.member_email];
            }
        }
        const failures = results.filter((line) => line.startsWith('FAIL'));
        assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
        assert.equal(results.length, 85);
    });
});
