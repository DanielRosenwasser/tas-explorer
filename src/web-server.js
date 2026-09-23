import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

/** @import { parseArgs, queryTreatment } from './cli.js' */
/** @import { FetchFn } from 'tas-client' */
/** @import { IncomingMessage, Server, ServerResponse } from 'node:http' */

/**
 * @typedef {Extract<ReturnType<typeof parseArgs>, { command: string }>} QueryOptions
 * @typedef {Awaited<ReturnType<typeof queryTreatment>> & { durationMs: number }} QueryResult
 * @typedef {(url: string, init: Parameters<FetchFn>[1] & { signal?: AbortSignal }) => ReturnType<FetchFn>} WebFetch
 * @typedef {object} WebDependencies
 * @property {typeof parseArgs} parseArgs
 * @property {(options: QueryOptions, fetch: FetchFn) => ReturnType<typeof queryTreatment>} query
 * @property {WebFetch} fetch
 * @property {{ write: (chunk: string) => unknown }} [stdout]
 */

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
/** @type {Record<string, [string, string]>} */
const ASSETS = {
    '/': ['web-ui.html', 'text/html; charset=utf-8'],
    '/web-ui.css': ['web-ui.css', 'text/css; charset=utf-8'],
    '/web-ui.js': ['web-ui.js', 'text/javascript; charset=utf-8'],
};

class HttpError extends Error {
    /** @param {number} status @param {string} message */
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** @param {unknown} error */
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

/** @param {ServerResponse} response @param {number} status @param {unknown} body */
function sendJson(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

/** @param {IncomingMessage} request @returns {Promise<string>} */
function readBody(request) {
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        let exceeded = false;
        request.on('data', (/** @type {Buffer} */ chunk) => {
            if (exceeded) {
                return;
            }
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                exceeded = true;
                chunks.length = 0;
                reject(new HttpError(413, 'Query payload exceeds 64 KiB.'));
            } else {
                chunks.push(chunk);
            }
        });
        request.on('end', () => {
            if (!exceeded) {
                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        });
        request.on('error', reject);
        request.on('aborted', () => reject(new HttpError(400, 'Query request was aborted.')));
    });
}

/** @param {unknown} body @returns {body is { args: string[] }} */
function isQueryPayload(body) {
    return typeof body === 'object' && body !== null && 'args' in body &&
        Array.isArray(body.args) && body.args.length <= 128 &&
        body.args.every((arg) => typeof arg === 'string') && body.args[0] === 'get' &&
        !body.args.some((arg) => ['--web', '--port', '--help', '-h', '--version', '-v'].includes(arg));
}

/** @param {Server} server */
export function getWebUrl(server) {
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('The web server is not listening on a TCP port.');
    }
    return `http://${HOST}:${address.port}`;
}

/** @param {QueryOptions} options @param {WebDependencies} dependencies */
export async function startWebServer(options, dependencies) {
    /** @type {Map<string, { type: string, content: Buffer }>} */
    const assets = new Map();
    await Promise.all(Object.entries(ASSETS).map(async ([route, [file, type]]) => {
        assets.set(route, { type, content: await readFile(new URL(file, import.meta.url)) });
    }));
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        try {
            const origin = getWebUrl(server);
            if (request.headers.host !== new URL(origin).host ||
                (request.headers.origin && request.headers.origin !== origin) ||
                request.headers['sec-fetch-site'] === 'cross-site') {
                throw new HttpError(403, 'Only same-origin local requests are allowed.');
            }
            const route = request.url ?? '';
            const asset = assets.get(route);
            if (request.method === 'GET' && asset) {
                response.writeHead(200, { 'Content-Type': asset.type });
                response.end(asset.content);
            } else if (route === '/api/defaults' && request.method === 'GET') {
                sendJson(response, 200, options);
            } else if (route === '/api/query' && request.method === 'POST') {
                if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                    throw new HttpError(415, 'Query requests must use application/json.');
                }
                /** @type {unknown} */
                let body;
                try {
                    body = JSON.parse(await readBody(request));
                } catch (error) {
                    if (error instanceof SyntaxError) {
                        throw new HttpError(400, 'Invalid JSON query payload.');
                    }
                    throw error;
                }
                if (!isQueryPayload(body)) {
                    throw new HttpError(400, 'Expected a get command with string arguments.');
                }
                const queryOptions = dependencies.parseArgs(body.args, {});
                if (!('command' in queryOptions) || !queryOptions.configId.trim() || !queryOptions.variableName.trim()) {
                    throw new HttpError(400, 'Config ID and variable name are required.');
                }
                try {
                    new Headers(queryOptions.filters);
                } catch (error) {
                    throw new HttpError(400, `Invalid request headers: ${formatError(error)}`);
                }
                const started = performance.now();
                /** @type {FetchFn} */
                const fetchWithTimeout = (url, init) => dependencies.fetch(url, {
                    ...init,
                    signal: AbortSignal.timeout(30_000),
                });
                const result = await dependencies.query(queryOptions, fetchWithTimeout);
                sendJson(response, 200, { ...result, durationMs: Math.round(performance.now() - started) });
            } else if (asset || ['/api/defaults', '/api/query'].includes(route)) {
                response.setHeader('Allow', route === '/api/query' ? 'POST' : 'GET');
                throw new HttpError(405, 'Method not allowed.');
            } else {
                throw new HttpError(404, 'Route not found.');
            }
        } catch (error) {
            const exitCode = error instanceof Error && 'exitCode' in error ? error.exitCode : undefined;
            const status = error instanceof HttpError ? error.status : exitCode === 2 ? 400 : exitCode === 3 ? 404 : 502;
            if (!response.destroyed) {
                sendJson(response, status, { error: formatError(error) });
            }
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 3000, HOST, () => {
            server.removeListener('error', reject);
            resolve(undefined);
        });
    });
    return server;
}

/** @param {QueryOptions} options @param {WebDependencies} dependencies */
export async function serveWeb(options, dependencies) {
    const server = await startWebServer(options, dependencies);
    const stop = () => {
        server.close();
        server.closeIdleConnections();
    };
    try {
        await new Promise((resolve, reject) => {
            server.once('close', () => resolve(undefined));
            server.once('error', reject);
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            (dependencies.stdout ?? process.stdout).write(`TAS web UI: ${getWebUrl(server)}\nPress Ctrl+C to stop.\n`);
        });
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        if (server.listening) {
            stop();
        }
    }
}
