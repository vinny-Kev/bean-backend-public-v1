import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checksum, listMigrationFiles, planMigrations } from './plan.mjs';

const directory = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const file = (version, sql = 'select 1;') => ({ version, name: `${version}_x.sql`, sql, checksum: checksum(sql) });

test('real migration files are numbered, contiguous and unique', () => {
    const files = listMigrationFiles(directory);
    assert.ok(files.length >= 9);
    assert.deepEqual(files.map((f) => f.version), files.map((_, i) => String(i + 1).padStart(3, '0')));
});

test('real migrations contain no destructive statements', () => {
    for (const f of listMigrationFiles(directory)) {
        assert.equal(/\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i.test(f.sql.replace(/--.*$/gm, '')), false, f.name);
    }
});

test('planMigrations reports pending, drift, missing files and gaps', () => {
    const files = [file('001'), file('002', 'select 2;'), file('003')];
    assert.deepEqual(planMigrations(files, []).pending.map((f) => f.version), ['001', '002', '003']);

    const applied = [{ version: '001', checksum: files[0].checksum }, { version: '002', checksum: 'stale' }, { version: '009', checksum: 'x' }];
    const plan = planMigrations(files, applied);
    assert.deepEqual(plan.pending.map((f) => f.version), ['003']);
    assert.deepEqual(plan.drifted.map((f) => f.version), ['002']);
    assert.deepEqual(plan.missing.map((r) => r.version), ['009']);
    assert.deepEqual(plan.gaps.map((f) => f.version), ['003'], '003 is pending although 009 is recorded');
});

test('checksum ignores CRLF versus LF', () => {
    assert.equal(checksum('a\r\nb'), checksum('a\nb'));
});
