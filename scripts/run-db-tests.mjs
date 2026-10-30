// Runs the PostgreSQL-backed tests against a scratch database named <name>_test on the same
// server as DATABASE_URL (default: bean_test). The real database is never rebuilt: the name
// must end in _test, and the test harness re-checks it. Usage: npm run test:db [-- <test files>]
import { spawnSync } from 'node:child_process';
import 'dotenv/config';

const source = process.env.DATABASE_URL?.trim();
if (!source) {
    console.error('DATABASE_URL is not set; point DB_* at a local *_test database and run node --test directly.');
    process.exit(1);
}
const url = new URL(source);
const scratch = process.env.BEAN_TEST_DB_NAME ?? 'bean_test';
if (!/_test$/.test(scratch)) { console.error('BEAN_TEST_DB_NAME must end in _test.'); process.exit(1); }
url.pathname = `/${scratch}`;

const files = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...(files.length ? files : ['src/**/*.db.test.js'])], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url.toString(), BEAN_ALLOW_REMOTE_TEST_DB: '1', MAIL_TRANSPORT: 'capture', LOGIN_STEP_UP: 'new-device', NODE_ENV: 'development' },
    shell: false,
});
process.exit(result.status ?? 1);
