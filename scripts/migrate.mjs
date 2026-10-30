// Migration runner with applied-version tracking (schema_migrations).
//
//   node scripts/migrate.mjs status                         read-only; reports applied/pending/drift
//   node scripts/migrate.mjs apply                          dry run: lists what would run
//   node scripts/migrate.mjs apply --execute --confirm-database <name>
//   node scripts/migrate.mjs baseline --through 009 --confirm-database <name>
//                                                           records versions as applied WITHOUT running them
//                                                           (for a database that already has them)
//
// Nothing is executed unless --execute (or baseline) is given together with the exact name of the
// connected database, so a stray .env pointing at a shared database cannot be modified by accident.
// Every migration runs in its own transaction together with its tracking row.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';
import { listMigrationFiles, planMigrations } from './migrations/plan.mjs';

const directory = fileURLToPath(new URL('../db/migrations', import.meta.url));
const [command = 'status', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] : undefined; };

const client = new pg.Client(config.database);
await client.connect();
const exitWith = async (code) => { await client.end().catch(() => {}); process.exit(code); };

try {
    const { rows: [{ database }] } = await client.query('SELECT current_database() AS database');
    const target = config.database.connectionString ? `${new URL(config.database.connectionString).hostname}/${database}` : `${config.database.host}/${database}`;
    console.log(`Target database: ${target}`);

    const hasTable = (await client.query(`SELECT to_regclass('public.schema_migrations') AS name`)).rows[0].name !== null;
    const applied = hasTable ? (await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows : [];
    const files = listMigrationFiles(directory);
    const plan = planMigrations(files, applied);

    console.log(`schema_migrations table: ${hasTable ? 'present' : 'absent (no migration has been recorded by this runner)'}`);
    for (const file of files) {
        const state = plan.drifted.includes(file) ? 'DRIFTED (file changed after it was recorded)' : plan.pending.includes(file) ? 'pending' : 'applied';
        console.log(`  ${file.name.padEnd(48)} ${state}`);
    }
    for (const row of plan.missing) console.log(`  recorded but file missing: ${row.version} ${row.name}`);
    if (plan.gaps.length) console.log(`WARNING: out-of-order pending versions: ${plan.gaps.map((f) => f.version).join(', ')}`);

    if (command === 'status') await exitWith(plan.drifted.length || plan.missing.length ? 1 : 0);

    const confirmed = option('confirm-database') === database;
    if (command === 'apply') {
        if (plan.drifted.length || plan.missing.length) { console.error('Refusing to apply: resolve drift/missing files first.'); await exitWith(1); }
        if (!flag('execute')) { console.log(`Dry run: would apply ${plan.pending.length} migration(s). Re-run with --execute --confirm-database ${database}.`); await exitWith(0); }
        if (!confirmed) { console.error(`--confirm-database must equal "${database}".`); await exitWith(1); }
        await client.query('SELECT pg_advisory_lock(727001)');
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        for (const file of plan.pending) {
            await client.query('BEGIN');
            try {
                await client.query(file.sql);
                await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [file.version, file.name, file.checksum]);
                await client.query('COMMIT');
                console.log(`applied ${file.name}`);
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`FAILED ${file.name}: ${error.message} (rolled back; later migrations were not attempted)`);
                await exitWith(1);
            }
        }
        await exitWith(0);
    }

    if (command === 'baseline') {
        const through = option('through');
        if (!/^\d{3}$/.test(through ?? '')) { console.error('--through NNN is required (e.g. 009).'); await exitWith(1); }
        if (!confirmed) { console.error(`--confirm-database must equal "${database}".`); await exitWith(1); }
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        for (const file of plan.pending.filter((f) => f.version <= through)) {
            await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [file.version, file.name, file.checksum]);
            console.log(`recorded (not executed) ${file.name}`);
        }
        await exitWith(0);
    }

    console.error(`Unknown command "${command}". Use status, apply or baseline.`);
    await exitWith(1);
} catch (error) {
    console.error(`Migration runner error: ${error.code ?? error.name}`);
    await exitWith(1);
}
