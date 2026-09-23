#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { ExperimentationService } from 'tas-client';
import { resolveVSCodeFilters } from './vscode-filters.js';
import { serveWeb } from './web-server.js';

const HELP = `Usage:
  tas get <config-id> <variable-name> [options]
  tas --web [options]

Options:
      --web                  Serve a local web UI instead of printing a value
      --port <number>        Web server port (default: 3000; 0 selects a free port)
  -e, --endpoint <url>       TAS endpoint (defaults to VS Code's endpoint)
  -f, --filter <key=value>   Override/add a request header; may be repeated
      --vscode <channel>     VS Code profile: stable or insiders (default: stable)
      --extension <id>       Override the default vscode-core caller
      --extension-version <version>
                             Override the detected installed version
      --language <locale>    Override the detected VS Code language
      --target <population>  Override public/insider/team/internal
      --window-kind <kind>   editor or agents (default: editor)
      --release-date <ISO>   Override the detected VS Code release date
      --no-vscode-filters    Disable automatic VS Code request headers
      --json                 Print a JSON result object
  -h, --help                 Show help
  -v, --version              Show version

Examples:
  tas get vscode copilot.enabled
  tas get vscode rollout --vscode insiders
  tas --web
  tas get vscode copilot.enabled --web --port 8080
`;

const VERSION = '1.0.0';
const DEFAULT_ENDPOINT = 'https://default.exp-tas.com/vscode/ab';

/**
 * @typedef {object} TreatmentOptions
 * @property {string} endpoint
 * @property {string} configId
 * @property {string} variableName
 * @property {Record<string, string>} filters
 * @property {string} [extensionName]
 * @typedef {import('./vscode-filters.js').FilterDependencies & {
 *   stdout?: { write: (chunk: string) => unknown },
 *   stderr?: { write: (chunk: string) => unknown },
 *   fetch?: import('tas-client').FetchFn
 * }} RunIO
 */

class CliError extends Error {
    /** @param {string} message */
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseArgs(argv, env = process.env) {
    const args = [...argv];
    /** @type {Record<string, string>} */
    const filters = {};
    const positionals = [];
    let endpoint = env.TAS_ENDPOINT ?? DEFAULT_ENDPOINT;
    let vscodeChannel = env.TAS_VSCODE_CHANNEL ?? 'stable';
    let extensionName = env.TAS_EXTENSION_NAME ?? 'vscode-core';
    let extensionVersion = env.TAS_EXTENSION_VERSION;
    let language = env.TAS_VSCODE_LANGUAGE;
    let targetPopulation = env.TAS_TARGET_POPULATION;
    let windowKind = env.TAS_VSCODE_WINDOW_KIND ?? 'editor';
    let releaseDate = env.TAS_VSCODE_RELEASE_DATE;
    let vscodeFilters = true;
    let json = false;
    let help = false;
    let version = false;
    let web = false;
    let port;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--help' || argument === '-h') {
            help = true;
        } else if (argument === '--version' || argument === '-v') {
            version = true;
        } else if (argument === '--web') {
            web = true;
        } else if (argument === '--port') {
            const value = readOptionValue(args, ++index, argument);
            if (!/^\d+$/.test(value) || Number(value) > 65535) {
                throw new CliError('--port must be an integer between 0 and 65535.', 2);
            }
            port = Number(value);
        } else if (argument === '--json') {
            json = true;
        } else if (argument === '--endpoint' || argument === '-e') {
            endpoint = readOptionValue(args, ++index, argument);
        } else if (argument === '--vscode') {
            vscodeChannel = readOptionValue(args, ++index, argument);
        } else if (argument === '--extension') {
            extensionName = readOptionValue(args, ++index, argument);
        } else if (argument === '--extension-version') {
            extensionVersion = readOptionValue(args, ++index, argument);
        } else if (argument === '--language') {
            language = readOptionValue(args, ++index, argument);
        } else if (argument === '--target') {
            targetPopulation = readOptionValue(args, ++index, argument);
        } else if (argument === '--window-kind') {
            windowKind = readOptionValue(args, ++index, argument);
        } else if (argument === '--release-date') {
            releaseDate = readOptionValue(args, ++index, argument);
        } else if (argument === '--no-vscode-filters') {
            vscodeFilters = false;
        } else if (argument === '--filter' || argument === '-f') {
            const filter = readOptionValue(args, ++index, argument);
            const separator = filter.indexOf('=');
            if (separator <= 0) {
                throw new CliError(`Invalid filter "${filter}"; expected key=value.`, 2);
            }
            filters[filter.slice(0, separator)] = filter.slice(separator + 1);
        } else if (argument.startsWith('-')) {
            throw new CliError(`Unknown option: ${argument}`, 2);
        } else {
            positionals.push(argument);
        }
    }

    if (help || version) {
        return { help, version };
    }
    if (port !== undefined && !web) {
        throw new CliError('--port requires --web.', 2);
    }
    if (!(web && positionals.length === 0)) {
        if (positionals[0] !== 'get') {
            throw new CliError('Expected the "get" command.', 2);
        }
        if (positionals.length !== 3) {
            throw new CliError('The "get" command requires <config-id> and <variable-name>.', 2);
        }
    }
    if (!['stable', 'insiders'].includes(vscodeChannel)) {
        throw new CliError('--vscode must be "stable" or "insiders".', 2);
    }
    if (
        targetPopulation &&
        !['team', 'internal', 'insider', 'public'].includes(targetPopulation)
    ) {
        throw new CliError('--target must be team, internal, insider, or public.', 2);
    }
    if (!['editor', 'agents'].includes(windowKind)) {
        throw new CliError('--window-kind must be "editor" or "agents".', 2);
    }

    let parsedEndpoint;
    try {
        parsedEndpoint = new URL(endpoint);
    } catch {
        throw new CliError(`Invalid TAS endpoint: ${endpoint}`, 2);
    }
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) {
        throw new CliError('The TAS endpoint must use HTTP or HTTPS.', 2);
    }

    return {
        command: 'get',
        configId: positionals[1] ?? 'vscode',
        variableName: positionals[2] ?? '',
        ...(web ? { web: true, port: port ?? 3000 } : {}),
        endpoint: parsedEndpoint.href,
        filters,
        vscodeChannel,
        vscodeFilters,
        extensionName,
        extensionVersion,
        language,
        targetPopulation,
        windowKind,
        releaseDate,
        cliVersion: VERSION,
        json,
    };
}

/**
 * @param {string[]} args
 * @param {number} index
 * @param {string} option
 */
function readOptionValue(args, index, option) {
    const value = args[index];
    if (!value || value.startsWith('-')) {
        throw new CliError(`Missing value for ${option}.`, 2);
    }
    return value;
}

/**
 * @param {TreatmentOptions} options
 * @param {import('tas-client').FetchFn} [fetchImplementation]
 */
export async function getTreatmentVariable(options, fetchImplementation = globalThis.fetch) {
    if (typeof fetchImplementation !== 'function') {
        throw new CliError('This command requires a runtime with the Fetch API.');
    }

    /** @type {unknown} */
    let transportError;
    /** @type {number | undefined} */
    let responseStatus;
    /** @type {import('tas-client').FetchFn} */
    const fetchAdapter = async (url, init) => {
        try {
            const response = await fetchImplementation(url, init);
            responseStatus = response.status;
            return {
                status: response.status,
                json: async () => {
                    try {
                        return await response.json();
                    } catch (error) {
                        transportError = error;
                        throw error;
                    }
                },
            };
        } catch (error) {
            transportError = error;
            throw error;
        }
    };

    const filterProvider = {
        getFilters: () => new Map(Object.entries(options.filters)),
    };
    const telemetry = {
        setSharedProperty: () => {},
        postEvent: () => {},
    };
    const service = new ExperimentationService({
        endpoint: options.endpoint,
        extensionName: options.extensionName ?? 'tas-value-cli',
        filterProviders: Object.keys(options.filters).length > 0 ? [filterProvider] : [],
        telemetry,
        assignmentContextTelemetryPropertyName: 'assignmentContext',
        telemetryEventName: 'treatmentVariableQuery',
        refetchInterval: 0,
        fetch: fetchAdapter,
    });

    try {
        await service.initialFetch;
        if (transportError) {
            throw new CliError(`TAS request failed: ${formatError(transportError)}`);
        }
        if (responseStatus !== undefined && (responseStatus < 200 || responseStatus > 299)) {
            throw new CliError(`TAS request failed with HTTP ${responseStatus}.`);
        }
        return service.getTreatmentVariable(options.configId, options.variableName);
    } finally {
        service.dispose();
    }
}

/** @param {unknown} error */
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @param {TreatmentOptions & import('./vscode-filters.js').FilterOptions & { vscodeFilters: boolean }} options
 * @param {RunIO} [io]
 */
export async function queryTreatment(options, io = {}) {
    const automaticFilters = options.vscodeFilters
        ? resolveVSCodeFilters(options, {
              env: io.env ?? process.env,
              execute: io.execute,
              readFile: io.readFile,
              platform: io.platform,
              home: io.home,
          })
        : {};
    const filters = { ...automaticFilters, ...options.filters };
    const value = await getTreatmentVariable({ ...options, filters }, io.fetch ?? globalThis.fetch);
    if (value === undefined) {
        throw new CliError(
            `Treatment variable "${options.variableName}" was not found in config "${options.configId}".`,
            3,
        );
    }
    return { configId: options.configId, variable: options.variableName, value, filters };
}

/**
 * @param {string[]} argv
 * @param {RunIO} [io]
 */
export async function run(argv, io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const env = io.env ?? process.env;

    try {
        const options = parseArgs(argv, env);
        if (!('command' in options)) {
            stdout.write(options.help ? HELP : `${VERSION}\n`);
            return 0;
        }

        if (options.web) {
            await serveWeb(options, {
                parseArgs,
                query: (queryOptions, fetch) => queryTreatment(queryOptions, { ...io, env, fetch }),
                stdout,
                fetch: io.fetch ?? globalThis.fetch,
            });
            return 0;
        }

        const { value, filters } = await queryTreatment(options, io);
        console.table(filters);
        const output = options.json
            ? { configId: options.configId, variable: options.variableName, value }
            : value;
        stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output)}\n`);
        return 0;
    } catch (error) {
        const message = formatError(error);
        stderr.write(`tas: ${message}\n`);
        return error instanceof CliError ? error.exitCode : 1;
    }
}

const isEntrypoint =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
    process.exitCode = await run(process.argv.slice(2));
}
