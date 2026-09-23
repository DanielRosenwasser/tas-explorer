import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { parseArgs, queryTreatment, run } from '../src/cli.js';
import { getWebUrl, startWebServer } from '../src/web-server.js';

/** @import { TestContext } from 'node:test' */
/** @import { WebDependencies, WebFetch } from '../src/web-server.js' */

/** @param {string[]} args */
function parseQuery(args) {
    const options = parseArgs(args, {});
    assert.ok('command' in options);
    return options;
}

/** @param {unknown} [value] */
const tasResponse = (value = true) => async () => new Response(JSON.stringify({
    Configs: [{ Id: 'vscode', Parameters: { 'feature.enabled': value } }],
    AssignmentContext: 'context',
}), { status: 200, headers: { 'content-type': 'application/json' } });

/** @param {TestContext} t @param {Partial<WebDependencies>} [overrides] */
async function setup(t, overrides = {}) {
    const options = parseQuery(['--web', '--port', '0', '--no-vscode-filters']);
    const server = await startWebServer(options, {
        parseArgs,
        fetch: tasResponse(),
        query: (queryOptions, fetch) => queryTreatment(queryOptions, { fetch, env: {} }),
        ...overrides,
    });
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve(undefined));
        server.closeAllConnections();
    }));
    const url = getWebUrl(server);
    /** @param {unknown} [args] */
    const query = (args = ['get', 'vscode', 'feature.enabled', '--no-vscode-filters']) => fetch(`${url}/api/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args }),
    });
    return { server, url, query };
}

test('parses standalone and prefilled web mode without changing get defaults', () => {
    const options = parseQuery(['--web']);
    assert.equal(options.web, true);
    assert.equal(options.port, 3000);
    assert.equal(options.configId, 'vscode');
    assert.equal(options.variableName, '');
    const prefilled = parseQuery(['get', 'my-config', 'my.variable', '--web', '--port', '8123']);
    assert.equal(prefilled.configId, 'my-config');
    assert.equal(prefilled.variableName, 'my.variable');
    assert.equal(prefilled.port, 8123);
    assert.equal(parseQuery(['get', 'vscode', 'value']).web, undefined);
    for (const args of [
        ['--port', '3000'], ['--web', '--port', '-1'], ['--web', '--port', '65536'],
        ['--web', '--port', '1.5'], ['--web', '--port', 'oops'], ['--web', '--port'],
        ['get', 'vscode', '--web'], ['unexpected', '--web'],
    ]) {
        assert.throws(() => parseArgs(args, {}), (error) => error instanceof Error && 'exitCode' in error && error.exitCode === 2);
    }
});

test('serves dependency-free assets and defaults only on loopback', async (t) => {
    const { server, url } = await setup(t);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    for (const [route, type, text] of [
        ['/', 'text/html', 'Treatment explorer'],
        ['/web-ui.css', 'text/css', '@media'],
        ['/web-ui.js', 'text/javascript', 'textContent'],
    ]) {
        const response = await fetch(`${url}${route}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', new RegExp(type));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
        assert.ok((await response.text()).includes(text));
    }
    const defaults = await (await fetch(`${url}/api/defaults`)).json();
    assert.equal(defaults.configId, 'vscode');
    assert.equal(defaults.vscodeFilters, false);
    assert.equal((await fetch(`${url}/does-not-exist`)).status, 404);
    assert.equal((await fetch(`${url}/../package.json`)).status, 404);
    const wrongMethod = await fetch(`${url}/api/query`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('queries real tas-client, forwards overrides, and supplies a request timeout', async (t) => {
    const timeout = t.mock.method(AbortSignal, 'timeout');
    /** @type {{ url: string, init: Parameters<WebFetch>[1] } | undefined} */
    let request;
    const { query } = await setup(t, {
        fetch: async (url, init) => {
            request = { url, init };
            return tasResponse(false)();
        },
    });
    const response = await query(['get', 'vscode', 'feature.enabled', '--no-vscode-filters',
        '--endpoint', 'https://example.test/tas', '--filter', 'X-Custom=a=b']);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['configId', 'durationMs', 'filters', 'value', 'variable']);
    assert.equal(result.value, false);
    assert.equal(result.configId, 'vscode');
    assert.equal(result.variable, 'feature.enabled');
    assert.deepEqual(result.filters, { 'X-Custom': 'a=b' });
    assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
    assert.ok(request);
    assert.equal(request.url, 'https://example.test/tas');
    assert.equal(request.init.headers['X-Custom'], 'a=b');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.equal(timeout.mock.calls.length, 1);
    assert.equal(timeout.mock.calls[0].arguments[0], 30_000);
});

test('preserves falsy values and structured values in web results', async (t) => {
    for (const value of [false, 0, '', null, ['a'], { nested: 'value' }]) {
        const { query } = await setup(t, { fetch: tasResponse(value) });
        const response = await query();
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).value, value);
    }
});

test('web queries resolve the same VS Code identity and override precedence as CLI', async (t) => {
    const { query } = await setup(t, {
        query: (options, fetch) => queryTreatment(options, {
            fetch, env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, platform: 'win32',
            readFile: () => JSON.stringify({ 'telemetry.machineId': 'machine', 'telemetry.devDeviceId': 'device' }),
            execute: () => '1.136.1\ncommit\nx64\n',
        }),
    });
    const response = await query(['get', 'vscode', 'feature.enabled', '--vscode', 'insiders',
        '--language', 'fr', '--window-kind', 'agents', '--filter', 'X-VSCode-Language=de']);
    assert.equal(response.status, 200);
    const { filters } = await response.json();
    assert.equal(filters['X-MSEdge-ClientId'], 'machine');
    assert.equal(filters['X-VSCode-DevDeviceId'], 'device');
    assert.equal(filters['X-VSCode-TargetPopulation'], 'insider');
    assert.equal(filters['X-VSCode-Language'], 'de');
    assert.equal(filters['X-VSCode-WindowKind'], 'agents');
});

test('rejects invalid payloads, headers, CLI options, and cross-origin requests', async (t) => {
    const { url, query } = await setup(t);
    for (const args of [null, [1], [], ['--web'], ['get', 'vscode', 'value', '--web'],
        ['get', 'vscode', 'value', '--help'], ['get', 'vscode', 'value', '--bogus'],
        ['get', '', 'value'], ['get', 'vscode', ' '],
        ['get', 'vscode', 'value', '--endpoint', 'file:///test'],
        ['get', 'vscode', 'value', '--filter', 'Bad Header=value'],
        ['get', 'vscode', 'value', '--filter', 'X-Test=value\r\ninjected']]) {
        const response = await query(args);
        assert.equal(response.status, 400, JSON.stringify(args));
        assert.equal(typeof (await response.json()).error, 'string');
    }
    /** @type {[string, Record<string, string>, number][]} */
    const invalidRequests = [
        ['{', { 'Content-Type': 'application/json' }, 400],
        ['{}', { 'Content-Type': 'text/plain' }, 415],
        ['x'.repeat(65537), { 'Content-Type': 'application/json' }, 413],
        ['{}', { 'Content-Type': 'application/json', Origin: 'https://example.test' }, 403],
        ['{}', { 'Content-Type': 'application/json', Host: 'example.test' }, 403],
        ['{}', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, 403],
    ];
    for (const [body, headers, status] of invalidRequests) {
        // Use node:http because fetch normalizes or replaces some browser-controlled headers.
        const response = await new Promise((resolve, reject) => {
            const request = httpRequest(`${url}/api/query`, { method: 'POST', headers }, (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { text += chunk; });
                response.on('error', reject);
                response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
            });
            request.on('error', reject);
            request.end(body);
        });
        assert.equal(response.status, status, JSON.stringify(headers));
        assert.equal(typeof response.body.error, 'string');
    }
});

test('surfaces missing treatments and upstream failures without success-shaped results', async (t) => {
    /** @type {[WebFetch, number, RegExp][]} */
    const failures = [
        [tasResponse(), 404, /was not found/],
        [async () => new Response('unavailable', { status: 503 }), 502, /HTTP 503/],
        [async () => new Response('not json', { status: 200 }), 502, /TAS request failed/],
        [async () => { throw new Error('network unavailable'); }, 502, /network unavailable/],
    ];
    for (const [fetchImplementation, status, message] of failures) {
        const { query } = await setup(t, { fetch: fetchImplementation });
        const response = await query(['get', 'vscode', 'missing', '--no-vscode-filters']);
        assert.equal(response.status, status);
        const body = await response.json();
        assert.match(body.error, message);
        assert.equal(Object.hasOwn(body, 'value'), false);
    }
});

test('reports occupied web ports as CLI runtime errors', async (t) => {
    const { server } = await setup(t);
    let stderr = '';
    const code = await run(['--web', '--port', new URL(getWebUrl(server)).port], {
        env: {}, stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, 1);
    assert.match(stderr, /EADDRINUSE/);
});

test('CLI server stays responsive until terminated without resolving VS Code identity at startup', { timeout: 10_000 }, async (t) => {
    const child = spawn(process.execPath, ['src\\cli.js', '--web', '--port', '0'], {
        cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
            if (match) resolve(match[0]);
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Server exited before startup: ${code}`)));
    });
    const url = await ready;
    assert.equal((await fetch(url)).status, 200);
    assert.match(output, /Ctrl\+C/);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
});
