import { isDeepStrictEqual } from 'node:util';

// Emulates the parts of Requestly's API Client runtime that the collection relies on, as
// documented at docs.requestly.com (api-client/scripts, tests, rq-response, rq-execution,
// variable-precedence, collection-runner, cookies):
// - `rq.test`, Chai-style `rq.expect`, `rq.response.code/json()/text()/headers`,
//   `rq.request.headers.upsert`, `rq.execution.setNextRequest(rq.execution.location.current)`;
// - variable precedence: runtime > environment > collection > globals;
// - the Collection Runner runs requests sequentially with an optional delay;
// - cookies: `jar` mode models the desktop cookie jar (a manual Cookie header wins); `header`
//   mode models no jar but a readable Set-Cookie header. Scripts must work in both.

// Chai BDD semantics for the chains the collection uses. Anything else throws, so the
// emulation can never silently pass an assertion it does not model. Pass real Chai's
// `expect` to `runFolder` to cross-check.
const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
export const minimalExpect = (actual, message) => {
    const fail = (text) => { throw new Error(message ? `${message}: ${text}` : text); };
    const make = (negate) => {
        const check = (pass, text) => { if (pass === negate) fail(`expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}${text}`); };
        const api = {
            equal: (expected) => check(actual === expected, `to equal ${JSON.stringify(expected)}`),
            eql: (expected) => check(isDeepStrictEqual(actual, expected), `to deeply equal ${JSON.stringify(expected)}`),
            include: (needle) => {
                if (typeof actual === 'string' || Array.isArray(actual)) return check(actual.includes(needle), `to include ${JSON.stringify(needle)}`);
                return fail(`include is only modeled for strings and arrays, got ${typeOf(actual)}`);
            },
            match: (pattern) => {
                if (typeof actual !== 'string') return fail('match requires a string');
                return check(pattern.test(actual), `to match ${pattern}`);
            },
            a: (type) => check(typeOf(actual) === type, `to be a ${type}`),
            property: (name) => {
                if (actual === null || typeof actual !== 'object') return fail('property requires an object');
                return check(name in actual, `to have property ${name}`);
            },
        };
        api.an = api.a;
        const chain = { ...api };
        chain.be = chain;
        chain.have = chain;
        return chain;
    };
    const to = make(false);
    to.not = make(true);
    return new Proxy({ to }, { get: (target, key) => (key in target ? target[key] : fail(`unsupported chain .${String(key)}`)) });
};

const resolve = (text, scopes) => text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    for (const scope of scopes) if (scope.has(key)) return String(scope.get(key));
    return match;
});

// A script that throws is reported as a failed check for that request, as a runner would show it.
const runScript = (code, rq, tests) => {
    try { new Function('rq', `'use strict';\n${code}`)(rq); } catch (error) { tests.push({ name: 'Script error', passed: false, error: error.message }); }
};

const flatten = (items, path = []) => items.flatMap((item) => (item.item
    ? flatten(item.item, [...path, item.name]) : [{ ...item, path: [...path, item.name].join(' > ') }]));

export const runFolder = async ({ collection, folderName, baseUrl, cookieMode = 'jar', expect = minimalExpect,
    beforeRequest = async () => {}, delayMs = 0, maxRequests = 2000 }) => {
    const folder = collection.item.find((item) => item.name === folderName);
    if (!folder) throw new Error(`Folder not found: ${folderName}`);
    const requests = flatten(folder.item);
    const runtime = new Map();
    const environment = new Map();
    const collectionVars = new Map(collection.variable.map((v) => [v.key, v.value]));
    collectionVars.set('base_url', baseUrl);
    const globals = new Map();
    const scopes = [runtime, environment, collectionVars, globals];
    const jar = new Map();
    const results = [];

    let index = 0;
    let executed = 0;
    while (index < requests.length) {
        if ((executed += 1) > maxRequests) throw new Error('Runner exceeded maxRequests (polling loop?)');
        const item = requests[index];
        await beforeRequest(item);
        const headers = new Map(item.request.header.filter((h) => !h.disabled).map((h) => [h.key.toLowerCase(), { key: h.key, value: h.value }]));
        const tests = [];
        let nextIndex = index + 1;
        const scriptsFor = (listen) => (item.event ?? []).filter((e) => e.listen === listen).map((e) => e.script.exec.join('\n'));
        const variableApi = (map) => ({ get: (key) => map.get(key), set: (key, value) => { map.set(key, value); }, has: (key) => map.has(key) });
        const baseRq = {
            variables: { get: (key) => { for (const scope of scopes) if (scope.has(key)) return scope.get(key); return undefined; },
                set: (key, value) => { runtime.set(key, value); } },
            environment: variableApi(environment),
            collectionVariables: variableApi(collectionVars),
            globals: variableApi(globals),
            expect,
            test: (name, fn) => {
                try { fn(); tests.push({ name, passed: true }); } catch (error) { tests.push({ name, passed: false, error: error.message }); }
            },
            execution: {
                location: { current: item.path },
                setNextRequest: (target) => {
                    const found = requests.findIndex((r) => r.path === target || r.name === target);
                    if (found < 0) throw new Error(`setNextRequest target not found: ${target}`);
                    nextIndex = found;
                },
            },
        };
        for (const code of scriptsFor('prerequest')) {
            runScript(code, { ...baseRq, request: { method: item.request.method,
                headers: { upsert: ({ key, value }) => headers.set(key.toLowerCase(), { key, value }),
                    get: (key) => headers.get(key.toLowerCase())?.value } } }, tests);
        }
        const url = resolve(item.request.url.raw, scopes);
        const sendHeaders = Object.fromEntries([...headers.values()].map(({ key, value }) => [key, resolve(value, scopes)]));
        if (cookieMode === 'jar' && !headers.has('cookie') && jar.size) {
            sendHeaders.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        }
        const response = await fetch(url, { method: item.request.method, headers: sendHeaders,
            body: item.request.body ? resolve(item.request.body.raw, scopes) : undefined });
        const setCookies = response.headers.getSetCookie();
        if (cookieMode === 'jar') {
            for (const header of setCookies) {
                const [pair, ...attributes] = header.split(';');
                const [name, value] = pair.split('=');
                if (!value || attributes.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) jar.delete(name.trim()); else jar.set(name.trim(), value);
            }
        }
        const text = await response.text();
        const responseHeaders = {
            get: (name) => (name.toLowerCase() === 'set-cookie' ? (cookieMode === 'header' && setCookies.length ? setCookies.join(', ') : null)
                : response.headers.get(name)),
            has: (name) => response.headers.has(name),
        };
        for (const code of scriptsFor('test')) {
            runScript(code, { ...baseRq, response: { code: response.status, body: text, text: () => text, json: () => JSON.parse(text),
                headers: responseHeaders } }, tests);
        }
        results.push({ path: item.path, status: response.status, tests });
        index = nextIndex;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    return { results, runtime };
};
