// Guards the API documentation: every registered route is documented, the committed Postman
// files match the spec, request bodies are valid JSON, and no secrets are committed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildCollection, buildEnvironment } from './build.mjs';
import { computeCoverage } from './check-coverage.mjs';
import { secretVariables } from './spec/index.mjs';

const readJson = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'));
const requests = (collection) => collection.item.flatMap((folder) => folder.item);

test('every registered route has exactly one spec entry and one Postman request', () => {
    const c = computeCoverage();
    assert.ok(c.registeredKeys.length >= 58, 'route discovery found the application routes');
    for (const key of ['missingFromSpec', 'missingFromCollection', 'unknownInSpec', 'unknownInCollection',
        'duplicateRegistrations', 'duplicateSpec', 'duplicateRequests', 'requestsMissingSections', 'authUndocumented']) {
        assert.deepEqual(c[key], [], key);
    }
});

test('committed Postman files are exactly what the generator produces (run `npm run docs:api`)', () => {
    assert.deepEqual(readJson('postman/Bean-Enterprise-Management.postman_collection.json'), buildCollection());
    assert.deepEqual(readJson('postman/Bean-Local.postman_environment.json.example'), buildEnvironment());
});

test('collection is structurally valid Postman v2.1', () => {
    const collection = buildCollection();
    assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    for (const item of requests(collection)) {
        assert.ok(item.name && item.request.method, item.name);
        assert.ok(item.request.url.raw.startsWith('{{baseUrl}}/'), item.name);
        assert.ok(item.request.description.content.length > 200, `${item.name} has a real description`);
        assert.ok(item.event.some((e) => e.listen === 'test'), `${item.name} has tests`);
        if (item.request.body) {
            const sample = item.request.body.raw.replace(/\{\{\w+\}\}/g, '1');
            assert.doesNotThrow(() => JSON.parse(sample), `${item.name} body is valid JSON`);
        }
        const unsafe = !['GET', 'HEAD'].includes(item.request.method);
        const headers = item.request.header.map((h) => h.key.toLowerCase());
        if (unsafe && !headers.includes('x-bean-app-key')) assert.ok(headers.includes('origin'), `${item.name} sends Origin`);
    }
});

test('no secrets are committed in the collection or environment template', () => {
    const collection = buildCollection();
    for (const name of secretVariables) assert.equal(collection.variable.find((v) => v.key === name).value, '', name);
    for (const value of buildEnvironment().values.filter((v) => secretVariables.includes(v.key))) assert.equal(value.value, '');
    const text = JSON.stringify([collection, buildEnvironment()]);
    assert.equal(/Bearer [A-Za-z0-9._~-]{20,}/.test(text), false, 'no literal bearer token');
    assert.equal(/bean\.sid=[A-Za-z0-9%._-]{10,}/.test(text), false, 'no literal session cookie');
});
