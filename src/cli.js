#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { ExperimentationService } from 'tas-client';
import { resolveVSCodeFilters } from './vscode-filters.js';

const HELP = `Usage:
  tas get <config-id> <variable-name> [options]

Options:
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
`;

const VERSION = '1.0.0';
const DEFAULT_ENDPOINT = 'https://default.exp-tas.com/vscode/ab';

class CliError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

export function parseArgs(argv, env = process.env) {
    const args = [...argv];
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

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--help' || argument === '-h') {
            help = true;
        } else if (argument === '--version' || argument === '-v') {
            version = true;
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
    if (positionals[0] !== 'get') {
        throw new CliError('Expected the "get" command.', 2);
    }
    if (positionals.length !== 3) {
        throw new CliError('The "get" command requires <config-id> and <variable-name>.', 2);
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
        configId: positionals[1],
        variableName: positionals[2],
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

function readOptionValue(args, index, option) {
    const value = args[index];
    if (!value || value.startsWith('-')) {
        throw new CliError(`Missing value for ${option}.`, 2);
    }
    return value;
}

export async function getTreatmentVariable(options, fetchImplementation = globalThis.fetch) {
    if (typeof fetchImplementation !== 'function') {
        throw new CliError('This command requires a runtime with the Fetch API.');
    }

    let transportError;
    let responseStatus;
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

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

export async function run(argv, io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const env = io.env ?? process.env;
    const fetchImplementation = io.fetch ?? globalThis.fetch;

    try {
        const options = parseArgs(argv, env);
        if (options.help) {
            stdout.write(HELP);
            return 0;
        }
        if (options.version) {
            stdout.write(`${VERSION}\n`);
            return 0;
        }

        const automaticFilters = options.vscodeFilters
            ? resolveVSCodeFilters(options, {
                  env,
                  execute: io.execute,
                  readFile: io.readFile,
                  platform: io.platform,
                  home: io.home,
              })
            : {};
        options.filters = { ...automaticFilters, ...options.filters };
        console.table(options.filters);

        const value = await getTreatmentVariable(options, fetchImplementation);
        if (value === undefined) {
            throw new CliError(
                `Treatment variable "${options.variableName}" was not found in config "${options.configId}".`,
                3,
            );
        }

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
