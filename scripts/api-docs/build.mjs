// Generates the Postman collection, the Postman environment template and docs/api/API_REFERENCE.md
// from the single endpoint specification in ./spec. Run: npm run docs:api
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectionVariables, endpoints, expectedStatuses, folderOrder, isIngestion, secretVariables, successStatus, unsafe } from './spec/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = (value) => JSON.stringify(value, null, 2);
const statusText = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

const required = (value) => (value === true ? 'yes' : value === false ? 'no' : value);
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');

const bodyText = (endpoint) => {
    if (!endpoint.body) return null;
    let text = json(endpoint.body.example);
    for (const field of endpoint.bodyRawNumbers ?? []) text = text.replace(new RegExp(String.raw`("${field}":\s*)"(\{\{\w+\}\})"`, 'g'), '$1$2');
    return text;
};

const headersFor = (endpoint) => {
    const headers = [];
    if (endpoint.body) headers.push({ name: 'Content-Type', value: 'application/json', desc: 'Required; Postman sets it automatically for a raw JSON body.' });
    if (unsafe(endpoint) && !isIngestion(endpoint)) headers.push({ name: 'Origin', value: '{{origin}}', desc: 'Required on every non-GET request. Must equal one of the backend\'s `APP_ORIGINS` exactly (no trailing slash). Postman does not send `Origin` by itself.' });
    headers.push(...(endpoint.headers ?? []));
    return headers;
};

export const renderDescription = (endpoint, level = '**') => {
    const heading = (title) => (level === '**' ? `**${title}**` : `${level} ${title}`);
    const out = [];
    out.push(heading('Purpose'), endpoint.purpose, '');

    const auth = endpoint.auth;
    out.push(heading('Authentication and permissions'));
    out.push(`- Session: ${auth.session ? 'required (`bean.sid` cookie from **Log in**)' : 'not required'}`);
    out.push(`- Account permission: ${auth.permission ? `\`${auth.permission}\`` : 'none'}`);
    out.push(`- Tenant membership/role: ${auth.tenantRole ?? 'not applicable'}`);
    if (auth.notes) out.push(`- ${auth.notes}`);
    out.push('');

    out.push(heading('Prerequisites'));
    out.push(...(endpoint.prereq?.length ? endpoint.prereq.map((item) => `- ${item}`) : ['- None.']), '');

    out.push(heading('Headers'));
    const headers = headersFor(endpoint);
    out.push(`- \`Cookie: bean.sid=...\`: ${auth.session ? 'required; Postman\'s cookie jar sends it automatically after login' : 'not used'}.`);
    for (const header of headers) out.push(`- \`${header.name}: ${header.value}\`: ${header.desc}`);
    if (!headers.length) out.push('- No additional headers.');
    out.push(`- CSRF: ${isIngestion(endpoint) ? 'not applicable (server-to-server, no cookies)' : unsafe(endpoint) ? 'there is no CSRF token endpoint or header in this backend; protection is the `Origin` allow-list above plus `SameSite` session cookies' : 'safe method, no `Origin` check'}.`);
    out.push('');

    out.push(heading('Path and query parameters'));
    const params = [...(endpoint.pathParams ?? []).map((p) => ({ ...p, where: 'path' })), ...(endpoint.query ?? []).map((p) => ({ ...p, where: 'query' }))];
    out.push(...(params.length ? [table(['Name', 'In', 'Type', 'Description', 'Example'], params.map((p) => [`\`${p.name}\``, p.where, p.type, p.desc, p.example ? `\`${p.example}\`` : ''])) ] : ['None.']), '');

    out.push(heading('Request body'));
    if (!endpoint.body) {
        out.push(endpoint.bodyNote ?? 'No request body is required.', '');
    } else {
        out.push(table(['Field', 'Type', 'Required', 'Constraints'], endpoint.body.fields.map((f) => [`\`${f.name}\``, f.type, required(f.required), f.rules])), '');
        out.push('Valid example:', '```json', bodyText(endpoint), '```');
        for (const invalid of endpoint.body.invalid ?? []) out.push('', `Invalid example (${invalid.status}: ${invalid.note}):`, '```json', json(invalid.example), '```');
        out.push('');
    }

    out.push(heading('Expected responses'));
    for (const response of endpoint.responses) {
        out.push(`- **${response.status} ${statusText[response.status] ?? ''}**: ${response.note}`);
        if (response.body !== null && response.body !== undefined) {
            out.push('', '  ```json', ...(typeof response.body === 'string' ? [response.body] : json(response.body).split('\n')).map((line) => `  ${line}`), '  ```');
        }
    }
    out.push('');

    out.push(heading('Side effects'));
    out.push(...endpoint.sideEffects.map((item) => `- ${item}`), `- Audit: ${endpoint.audit}`, '');

    out.push(heading('Testing notes'));
    out.push(`- Asserts status ${expectedStatuses(endpoint).join(' or ')}${endpoint.tests?.length ? ' plus response-field checks' : ''}.`);
    out.push(`- Changes persistent state: ${endpoint.method === 'GET' && !endpoint.sideEffects.some((s) => /audit entry|Writes/.test(s)) ? 'no' : endpoint.method === 'GET' ? 'only a best-effort audit row' : 'yes'}.`);
    out.push(`- Safe to repeat: ${endpoint.repeat}`);
    for (const note of endpoint.notes ?? []) out.push(`- ${note}`);
    return out.join('\n');
};

const testScript = (endpoint) => {
    const expected = expectedStatuses(endpoint);
    const lines = [`pm.test('Status code is ${expected.join(' or ')}', () => pm.expect(pm.response.code).to.be.oneOf([${expected.join(', ')}]));`];
    if (successStatus(endpoint) !== 204) {
        lines.push("pm.test('Response is JSON', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include('application/json'));");
        lines.push("pm.test('Error responses use a documented shape', () => { if (pm.response.code >= 400) { const b = pm.response.json(); pm.expect(b.message !== undefined || (b.error && b.error.code)).to.be.ok; } });");
    }
    lines.push(...(endpoint.tests ?? []));
    for (const capture of endpoint.capture ?? []) {
        const guard = capture.requireStatus ?? successStatus(endpoint);
        lines.push(`if (pm.response.code === ${guard}) { const json = pm.response.json(); const value = ${capture.expr}; if (value !== undefined && value !== null && ${capture.onlyIfUnset ? `!pm.collectionVariables.get('${capture.variable}')` : 'true'}) pm.collectionVariables.set('${capture.variable}', String(value)); }`);
    }
    return lines;
};

const requestFor = (endpoint) => {
    const queryItems = (endpoint.query ?? []).map((q) => ({ key: q.name, value: q.example ?? '', disabled: q.name !== 'tenantId', description: `${q.type}. ${q.desc}` }));
    const segments = endpoint.path.split('/').filter(Boolean);
    const rawQuery = queryItems.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
    const request = {
        method: endpoint.method,
        header: headersFor(endpoint).map((h) => ({ key: h.name, value: h.value, description: h.desc, type: 'text' })),
        url: {
            raw: `{{baseUrl}}${endpoint.path}${rawQuery ? `?${rawQuery}` : ''}`,
            host: ['{{baseUrl}}'],
            path: segments,
            ...(queryItems.length && { query: queryItems }),
            ...((endpoint.pathParams?.length) && { variable: endpoint.pathParams.map((p) => ({ key: p.name, value: p.example, description: p.desc })) }),
        },
        description: { content: renderDescription(endpoint), type: 'text/markdown' },
    };
    if (endpoint.body) request.body = { mode: 'raw', raw: bodyText(endpoint), options: { raw: { language: 'json' } } };
    return request;
};

const itemFor = (endpoint) => {
    const request = requestFor(endpoint);
    const events = [{ listen: 'test', script: { type: 'text/javascript', exec: testScript(endpoint) } }];
    if (endpoint.preRequest) events.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: endpoint.preRequest } });
    return {
        name: endpoint.name,
        event: events,
        request,
        response: endpoint.responses.map((response) => ({
            name: `${response.status} ${response.note}`.slice(0, 120),
            originalRequest: { method: request.method, header: request.header, url: request.url, ...(request.body && { body: request.body }) },
            status: statusText[response.status] ?? 'Response',
            code: response.status,
            _postman_previewlanguage: typeof response.body === 'string' ? 'text' : 'json',
            header: response.body === null || response.body === undefined ? [] : [{ key: 'Content-Type', value: typeof response.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }],
            cookie: [],
            body: response.body === null || response.body === undefined ? '' : typeof response.body === 'string' ? response.body : json(response.body),
        })),
    };
};

const collectionDescription = `Documentation and smoke tests for every HTTP endpoint of the Bean Enterprise Management System backend (${endpoints.length} requests). Generated from \`scripts/api-docs\`; do not edit by hand (run \`npm run docs:api\`).

**How authentication works.** Browser-style sessions: **Log in** sets an HttpOnly \`bean.sid\` cookie that Postman's cookie jar replays. There is no CSRF token: every non-GET request must carry an \`Origin\` header equal to one of the backend's \`APP_ORIGINS\` (collection variable \`origin\`). Integration event delivery is the exception: it uses \`X-Bean-App-Key\` + \`Authorization: Bearer <secret>\`.

**Error shapes.** Two established shapes exist: \`{ "message": "..." }\` (auth, inventory, audit, parts of integrations) and \`{ "error": { "code", "message", "requestId"? } }\` (tenants, lifecycle, tickets, global errors). Permission failures carry both.

**Recommended run order** (against a disposable local database only; see README.md in the repo): Health → Authentication (Sign up, Log in) → Tenants (Create tenant, Add member, ...) → Inventory → Audit → Integrations (Register, Set event subscriptions, Activate, Deliver event, ...) → Tickets (Create inbox, Create ticket, Assign, ...). Several requests need an account role with specific permissions that only a database operator can grant; each request lists what it needs. Never point this collection at a shared or production database.

Secrets (\`signupPassword\`, \`userPassword\`, \`integrationCredential\`) are intentionally empty here; set them in your own environment.`;

export const buildCollection = () => ({
    info: {
        _postman_id: 'b3a4e1c0-6d2f-4a58-9a77-5e0b2d3c1f10',
        name: 'Bean Enterprise Management API',
        description: collectionDescription,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folderOrder.map((folder) => ({
        name: folder,
        item: endpoints.filter((endpoint) => endpoint.folder === folder).map(itemFor),
    })),
    variable: Object.entries(collectionVariables).map(([key, value]) => ({ key, value, type: 'string' })),
});

export const buildEnvironment = () => ({
    id: '6d1f0f6c-7c53-4a3e-8d2b-2c9e0a5f4b21',
    name: 'Bean Local',
    values: Object.entries(collectionVariables).filter(([key]) => ['baseUrl', 'origin', 'userEmail', 'userPassword', 'signupPassword', 'inviteEmail', 'integrationCredential'].includes(key)).map(([key, value]) => ({
        key, value, type: secretVariables.includes(key) ? 'secret' : 'default', enabled: true,
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'Bean api-docs generator',
});

const buildReference = () => {
    const lines = [
        '# Bean Enterprise Management API reference', '',
        `Generated from \`scripts/api-docs\` (${endpoints.length} endpoints). Do not edit by hand: run \`npm run docs:api\`. The same content ships as the request descriptions of \`postman/Bean-Enterprise-Management.postman_collection.json\`.`, '',
        '## Conventions', '',
        '- **Base URL**: `http://localhost:3000` by default (`PORT` / `HOST` in `.env`).',
        '- **Sessions**: `POST /auth/login/` sets the `bean.sid` HttpOnly cookie (1 hour sliding, 6 hour absolute lifetime) in the PostgreSQL session store.',
        '- **CSRF**: there is no CSRF token. Every non-GET/HEAD/OPTIONS request (except integration event delivery) must send an `Origin` header that exactly matches an `APP_ORIGINS` entry; other origins get `403 ORIGIN_DENIED`. Cookies are `SameSite=Lax` by default.',
        '- **Account permissions** come from the user\'s role (`roles` → `role_permissions`); **tenant authority** comes from `tenant_members` (`owner` / `admin` / `member`). Clients never supply a trusted tenant: the URL value only selects it, and non-members get 404 (or an empty list) so IDs cannot be probed.',
        '- **Error shapes**: `{ "message": "..." }` (auth, inventory, audit, parts of integrations) and `{ "error": { "code", "message", "requestId"? } }` (tenants, integration lifecycle, tickets, global handler). Permission failures carry both. 500s never include internals.',
        '- **Pagination** (`page`/`limit`/`offset`): `limit` 1–20 and `page` XOR `offset`.',
        '- **Rate limits**: signup 5/h/IP, login 3 failures/15 min/IP, tenant creation 10/h/user, integration registration 20/h/user, credential rotation 10/h/IP, event delivery 120/min/IP. Body limits: JSON 100 KB, form 10 KB.',
        '- **Audit**: see `docs/qa/audit-coverage.md`.', '',
        '## Endpoint index', '',
        table(['#', 'Method', 'Path', 'Name', 'Session', 'Permission'], endpoints.map((e, i) => [i + 1, e.method, `\`${e.path}\``, e.name, e.auth.session ? 'yes' : 'no', e.auth.permission ? `\`${e.auth.permission}\`` : '-'])), '',
    ];
    for (const folder of folderOrder) {
        lines.push(`## ${folder}`, '');
        for (const endpoint of endpoints.filter((e) => e.folder === folder)) {
            lines.push(`### ${endpoint.method} \`${endpoint.path}\` — ${endpoint.name}`, '', renderDescription(endpoint, '####'), '');
        }
    }
    return `${lines.join('\n')}\n`;
};

const write = (relative, content) => {
    const target = resolve(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    console.log(`wrote ${relative}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    write('postman/Bean-Enterprise-Management.postman_collection.json', `${json(buildCollection())}\n`);
    write('postman/Bean-Local.postman_environment.json.example', `${json(buildEnvironment())}\n`);
    write('docs/api/API_REFERENCE.md', buildReference());
}
