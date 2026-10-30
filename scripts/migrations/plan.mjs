import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const filePattern = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export const listMigrationFiles = (directory) => readdirSync(directory)
    .filter((name) => filePattern.test(name))
    .sort()
    .map((name) => {
        const sql = readFileSync(`${directory}/${name}`, 'utf8');
        return { version: filePattern.exec(name)[1], name, sql, checksum: checksum(sql) };
    });

// Compares migration files with the rows of schema_migrations. Pure; touches no database.
//   pending  - files not yet recorded, in order
//   drifted  - recorded, but the file content changed since it was applied
//   missing  - recorded, but the file no longer exists
//   gaps     - an earlier version is pending while a later one is already recorded
export const planMigrations = (files, applied) => {
    const recorded = new Map(applied.map((row) => [row.version, row]));
    const pending = files.filter((file) => !recorded.has(file.version));
    const drifted = files.filter((file) => recorded.has(file.version) && recorded.get(file.version).checksum !== file.checksum);
    const missing = applied.filter((row) => !files.some((file) => file.version === row.version));
    const lastApplied = applied.map((row) => row.version).sort().at(-1) ?? '000';
    const gaps = pending.filter((file) => file.version < lastApplied);
    return { pending, drifted, missing, gaps };
};
