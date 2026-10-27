import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe } from 'node:test';
import { pool } from '../../db/pool.js';
import { processIntegrationEventBatch } from '../services/integrationEventWorker.js';
import { seedOnboardingFixtures } from '../../../tests/requestly/seed-onboarding.mjs';
import { integrationTest as test, reportBlockedIntegrationCheck } from './integrationTestReporter.js';
import { runFolder } from './support/requestlyRunner.js';
import { resetSchema, testDatabaseSkipReason } from './support/testDatabase.js';
import { startTestServer, trustedOrigin } from './support/testServer.js';

// Runs the scripted "00 Onboarding pipeline (automated)" folder through an emulation of the
// Requestly runner (support/requestlyRunner.js) against a real-session server, in both cookie
// modes, and requires every script assertion to pass. The poll request triggers a worker batch,
// standing in for the background worker that server.js runs.
const collectionPath = new URL('../../../tests/requestly/bean-backend-e2e.postman_collection.json', import.meta.url);
const FOLDER = '00 Onboarding pipeline (automated)';
const skip = testDatabaseSkipReason || (!trustedOrigin && 'APP_ORIGINS must contain at least one origin.');
if (skip) reportBlockedIntegrationCheck('Requestly onboarding pipeline run', 'a local *_test database and APP_ORIGINS', `skipped: ${skip}`);

describe('Requestly onboarding pipeline folder', { skip, concurrency: false }, () => {
    let server;
    let collection;
    before(async () => {
        await resetSchema();
        collection = JSON.parse(readFileSync(collectionPath, 'utf8'));
        const password = collection.variable.find((v) => v.key === 'test_password').value;
        await seedOnboardingFixtures(pool, password);
        await seedOnboardingFixtures(pool, password); // idempotent
        server = await startTestServer({ realSessions: true });
    });
    after(async () => {
        await server?.close();
        await pool.end();
    });

    const run = async (cookieMode) => {
        collection.variable.find((v) => v.key === 'origin').value = trustedOrigin;
        const { results } = await runFolder({ collection, folderName: FOLDER, baseUrl: server.baseUrl, cookieMode,
            beforeRequest: async (item) => { if (item.name.startsWith('Wait for the worker')) await processIntegrationEventBatch(); } });
        const problems = [];
        for (const result of results) {
            if (!result.tests.length) problems.push(`${result.path}: no assertions ran`);
            for (const t of result.tests.filter((x) => !x.passed)) problems.push(`${result.path} [${result.status}]: ${t.name} -> ${t.error}`);
        }
        return { results, problems };
    };

    test('every assertion passes when the desktop cookie jar carries the session', async () => {
        const { results, problems } = await run('jar');
        assert.deepEqual(problems, []);
        assert.ok(results.length >= 76);
        assert.ok(results.reduce((n, r) => n + r.tests.length, 0) > 150, 'meaningful assertion coverage');
    });

    test('every assertion passes when scripts carry the session cookie instead of a jar', async () => {
        const { problems } = await run('header');
        assert.deepEqual(problems, []);
    });

    test('the pipeline is rerunnable and leaves an isolated tenant per run', async () => {
        const tenants = await pool.query(`SELECT t.slug, COUNT(tm.user_id)::int AS members FROM tenants t
            JOIN tenant_members tm ON tm.tenant_id=t.id WHERE t.slug LIKE 'requestly-%' AND t.slug<>'requestly-rival' GROUP BY t.slug`);
        assert.equal(tenants.rowCount, 2, 'one tenant per run');
        assert.ok(tenants.rows.every((row) => row.members === 4));
        const rival = await pool.query(`SELECT COUNT(*)::int AS n FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id WHERE t.slug='requestly-rival'`);
        assert.equal(rival.rows[0].n, 1, 'cross-tenant attempts never joined the rival tenant');
    });
});
