// Cross-checks the HTTP routes registered in src/ against the endpoint spec and the generated
// Postman collection, and writes docs/qa/endpoint-coverage.md. Exits non-zero on any gap.
// Run: npm run check:api
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpoints, routeKey } from './spec/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const normalize = (method, path) => `${method.toUpperCase()} ${path.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'}`.replace(/:[A-Za-z_]+/g, ':p');

// Routes registered in code: server.js mounts -> route files -> router.METHOD(...) calls,
// following one level of `parent.use('/prefix', childRouter)` nesting (used by ticketing).
export const discoverRegisteredRoutes = () => {
    const server = read('src/server.js');
    const imports = new Map([...server.matchAll(/import\s+(\w+)\s+from\s+'(\.\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    const routes = [];
    for (const [, mount, name] of server.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
        const file = imports.get(name);
        if (!file) continue;
        const source = read(`src/${file.replace('./', '')}`).replace(/^\s*\/\/.*$/gm, '');
        const prefixes = new Map();
        for (const [, , prefix, child] of source.matchAll(/(\w+)\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) prefixes.set(child, prefix);
        for (const [, variable, method, path] of source.matchAll(/\b(\w+)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]*)['"`]/g)) {
            routes.push({ method: method.toUpperCase(), path: `${mount}/${prefixes.get(variable) ?? ''}/${path}`, file });
        }
    }
    return routes.map((route) => ({ ...route, key: normalize(route.method, route.path) }));
};

const collectionRequests = () => {
    const path = resolve(root, 'postman/Bean-Enterprise-Management.postman_collection.json');
    if (!existsSync(path)) return [];
    const collection = JSON.parse(readFileSync(path, 'utf8'));
    const requests = [];
    const walk = (items) => items.forEach((item) => (item.item ? walk(item.item) : requests.push(item)));
    walk(collection.item);
    return requests.map((item) => {
        const raw = item.request.url.raw.replace('{{baseUrl}}', '').split('?')[0];
        return { name: item.name, description: item.request.description?.content ?? '', key: normalize(item.request.method, raw) };
    });
};

const duplicates = (keys) => [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

export const computeCoverage = () => {
    const registered = discoverRegisteredRoutes();
    const registeredKeys = registered.map((route) => route.key);
    const specKeys = endpoints.map(routeKey);
    const requests = collectionRequests();
    const requestKeys = requests.map((request) => request.key);
    const sections = ['Purpose', 'Authentication and permissions', 'Prerequisites', 'Headers', 'Path and query parameters', 'Request body', 'Expected responses', 'Side effects', 'Testing notes'];
    return {
        registered, registeredKeys, specKeys, requestKeys,
        missingFromSpec: registeredKeys.filter((key) => !specKeys.includes(key)),
        missingFromCollection: registeredKeys.filter((key) => !requestKeys.includes(key)),
        unknownInSpec: specKeys.filter((key) => !registeredKeys.includes(key)),
        unknownInCollection: requestKeys.filter((key) => !registeredKeys.includes(key)),
        duplicateRegistrations: duplicates(registeredKeys),
        duplicateSpec: duplicates(specKeys),
        duplicateRequests: duplicates(requestKeys),
        requestsMissingSections: requests.filter((request) => sections.some((section) => !request.description.includes(`**${section}**`))).map((request) => request.name),
        authUndocumented: endpoints.filter((endpoint) => !endpoint.auth || typeof endpoint.auth.session !== 'boolean').map((endpoint) => endpoint.key),
        contractUncertain: endpoints.filter((endpoint) => endpoint.expectedStatuses || endpoint.uncertain).map((endpoint) => ({ key: endpoint.key, reason: endpoint.uncertain ?? 'outcome depends on pre-existing data/state; documented outcomes asserted' })),
    };
};

const section = (title, items) => `## ${title}\n\n${items.length ? items.map((item) => `- ${typeof item === 'string' ? `\`${item}\`` : `\`${item.key}\`: ${item.reason}`}`).join('\n') : 'None.'}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const c = computeCoverage();
    const gaps = c.missingFromSpec.length + c.missingFromCollection.length + c.unknownInSpec.length + c.unknownInCollection.length
        + c.duplicateRegistrations.length + c.duplicateSpec.length + c.duplicateRequests.length + c.requestsMissingSections.length + c.authUndocumented.length;
    const report = `# Endpoint coverage report

Generated by \`npm run check:api\` (\`scripts/api-docs/check-coverage.mjs\`). Routes are discovered from the code: \`src/server.js\` mounts, then each router file's \`router.get/post/put/patch/delete\` calls.

| Measure | Count |
|---|---|
| Registered HTTP endpoints | ${c.registeredKeys.length} |
| Endpoints in the spec | ${c.specKeys.length} |
| Documented Postman requests | ${c.requestKeys.length} |
| Missing from spec | ${c.missingFromSpec.length} |
| Missing from Postman collection | ${c.missingFromCollection.length} |
| Documented but not registered | ${c.unknownInSpec.length + c.unknownInCollection.length} |
| Duplicate requests | ${c.duplicateRequests.length} |
| Requests missing a description section | ${c.requestsMissingSections.length} |
| Requests with unverified auth requirements | ${c.authUndocumented.length} |
| Requests with state-dependent / uncertain contracts | ${c.contractUncertain.length} |

${section('Missing from the Postman collection', c.missingFromCollection)}
${section('Missing from the spec', c.missingFromSpec)}
${section('Documented but not registered', [...c.unknownInSpec, ...c.unknownInCollection])}
${section('Duplicate requests', c.duplicateRequests)}
${section('Requests with an incomplete description', c.requestsMissingSections)}
${section('Requests whose authentication requirements are not established', c.authUndocumented)}
${section('Requests whose response contract is state-dependent or uncertain', c.contractUncertain)}
## Verification method and limits

Every contract was derived by reading the handler, middleware and validation code. The documented bodies, status codes and error shapes have **not** been replayed against a live database in this environment (no local test PostgreSQL was available), except where covered by the automated tests listed in \`docs/qa/final-report.md\`.
`;
    mkdirSync(resolve(root, 'docs/qa'), { recursive: true });
    writeFileSync(resolve(root, 'docs/qa/endpoint-coverage.md'), report, 'utf8');
    console.log(report.split('## Missing')[0]);
    if (gaps) { console.error(`Coverage gaps found: ${gaps}`); process.exitCode = 1; }
}
