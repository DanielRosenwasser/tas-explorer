import assert from 'node:assert/strict';
import test from 'node:test';
import { getTreatmentVariable, parseArgs, run } from '../src/cli.js';
import { resolveVSCodeFilters } from '../src/vscode-filters.js';

function capture() {
    let value = '';
    return {
        stream: { write: (chunk) => (value += chunk) },
        value: () => value,
    };
}

test('parses a get command and repeated filters', () => {
    assert.deepEqual(
        parseArgs([
            'get',
            'vscode',
            'feature.enabled',
            '--endpoint',
            'https://example.test/tas',
            '--extension',
            'ms-python.python',
            '--filter',
            'X-Version=1.2.3',
            '-f',
            'X-Target=desktop',
        ]),
        {
            command: 'get',
            configId: 'vscode',
            variableName: 'feature.enabled',
            endpoint: 'https://example.test/tas',
            filters: { 'X-Version': '1.2.3', 'X-Target': 'desktop' },
            vscodeChannel: 'stable',
            vscodeFilters: true,
            extensionName: 'ms-python.python',
            extensionVersion: undefined,
            language: undefined,
            targetPopulation: undefined,
            windowKind: 'editor',
            releaseDate: undefined,
            cliVersion: '1.0.0',
            json: false,
        },
    );
});

test('calculates the same generic filters as the VS Code client', () => {
    const filters = resolveVSCodeFilters(
        {
            vscodeChannel: 'stable',
            extensionName: 'ms-python.python',
            cliVersion: '1.0.0',
        },
        {
            env: {
                APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
                VSCODE_NLS_CONFIG: '{"locale":"fr"}',
            },
            platform: 'win32',
            home: 'C:\\Users\\test',
            readFile: (filePath) => {
                assert.match(filePath, /storage\.json$/);
                return JSON.stringify({
                    'telemetry.machineId': 'machine-123',
                    'telemetry.devDeviceId': 'device-456',
                });
            },
            execute: (_command, args) =>
                args.includes('--list-extensions')
                    ? 'ms-python.python@2026.12.0\n'
                    : '1.136.1\ncommit\narm64\n',
        },
    );

    assert.deepEqual(filters, {
        'X-MSEdge-Market': '',
        'X-FD-Corpnet': '',
        'X-VSCode-AppVersion': '1.136.1',
        'X-VSCode-Build': 'Visual Studio Code',
        'X-MSEdge-ClientId': 'machine-123',
        'X-VSCode-DevDeviceId': 'device-456',
        'X-VSCode-ExtensionName': 'ms-python.python',
        'X-VSCode-ExtensionVersion': '2026.12.0',
        'X-VSCode-Language': 'fr',
        'X-VSCode-TargetPopulation': 'public',
        'X-VSCode-Platform': 'windows',
        'X-VSCode-ReleaseDate': '',
        'X-VSCode-WindowKind': 'editor',
    });
});

test('always adds VS Code devDeviceId for the core assignment provider', () => {
    const filters = resolveVSCodeFilters(
        {
            vscodeChannel: 'stable',
            extensionName: 'vscode-core',
            windowKind: 'agents',
        },
        {
            env: {
                APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
                VSCODE_NLS_CONFIG: '{"locale":"en"}',
            },
            platform: 'win32',
            home: 'C:\\Users\\test',
            readFile: () =>
                JSON.stringify({
                    'telemetry.machineId': 'machine-123',
                    'telemetry.devDeviceId': '\uFEFFdevice-456',
                }),
            execute: () => '1.136.1\ncommit\narm64\n',
        },
    );

    assert.equal(filters['X-MSEdge-ClientId'], 'machine-123');
    assert.equal(filters['X-VSCode-DevDeviceId'], 'device-456');
    assert.equal(filters['X-VSCode-ExtensionName'], 'vscode-core');
    assert.equal(filters['X-VSCode-ExtensionVersion'], '999999.0');
    assert.equal(filters['X-VSCode-WindowKind'], 'agents');
});

test('uses persisted JSON-with-comments locale and explicit filter overrides', async () => {
    let headers;
    const exitCode = await run(
        [
            'get',
            'vscode',
            'feature.enabled',
            '--extension',
            'ms-python.python',
            '--filter',
            'X-VSCode-Language=de',
        ],
        {
            env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
            platform: 'win32',
            home: 'C:\\Users\\test',
            readFile: (filePath) =>
                filePath.endsWith('storage.json')
                    ? JSON.stringify({
                          'telemetry.machineId': 'machine-123',
                          'telemetry.devDeviceId': 'device-456',
                      })
                    : '{ // configured display language\n "locale": "fr" }',
            execute: (_command, args) =>
                args.includes('--list-extensions')
                    ? 'ms-python.python@2026.12.0\n'
                    : '1.136.1\ncommit\narm64\n',
            fetch: async (_url, init) => {
                headers = init.headers;
                return new Response(
                    JSON.stringify({
                        Configs: [
                            { Id: 'vscode', Parameters: { 'feature.enabled': true } },
                        ],
                        AssignmentContext: 'context',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            },
            stdout: capture().stream,
            stderr: capture().stream,
        },
    );

    assert.equal(exitCode, 0);
    assert.equal(headers['X-MSEdge-ClientId'], 'machine-123');
    assert.equal(headers['X-VSCode-ExtensionVersion'], '2026.12.0');
    assert.equal(headers['X-VSCode-Language'], 'de');
});

test('queries tas-client and forwards filters as headers', async () => {
    let request;
    const value = await getTreatmentVariable(
        {
            endpoint: 'https://example.test/tas',
            configId: 'vscode',
            variableName: 'feature.enabled',
            filters: { 'X-Version': '1.2.3' },
        },
        async (url, init) => {
            request = { url, init };
            return new Response(
                JSON.stringify({
                    Configs: [{ Id: 'vscode', Parameters: { 'feature.enabled': true } }],
                    AssignmentContext: 'context',
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        },
    );

    assert.equal(value, true);
    assert.equal(request.url, 'https://example.test/tas');
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.headers['X-Version'], '1.2.3');
});

test('prints JSON and reports a missing variable with exit code 3', async () => {
    const response = async () =>
        new Response(JSON.stringify({ Configs: [], AssignmentContext: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

    const stdout = capture();
    const stderr = capture();
    const exitCode = await run(
        [
            'get',
            'vscode',
            'missing',
            '--endpoint',
            'https://example.test/tas',
            '--no-vscode-filters',
            '--json',
        ],
        { stdout: stdout.stream, stderr: stderr.stream, fetch: response, env: {} },
    );

    assert.equal(exitCode, 3);
    assert.equal(stdout.value(), '');
    assert.match(stderr.value(), /was not found/);
});

test('reports non-successful HTTP responses', async () => {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await run(
        [
            'get',
            'vscode',
            'value',
            '--endpoint',
            'https://example.test/tas',
            '--no-vscode-filters',
        ],
        {
            stdout: stdout.stream,
            stderr: stderr.stream,
            fetch: async () => new Response('unavailable', { status: 503 }),
            env: {},
        },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr.value(), /HTTP 503/);
});
