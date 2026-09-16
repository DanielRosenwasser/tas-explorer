import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CHANNELS = {
    stable: {
        command: 'code',
        dataDirectory: 'Code',
        installDirectory: 'Microsoft VS Code',
        appName: 'Visual Studio Code',
        targetPopulation: 'public',
    },
    insiders: {
        command: 'code-insiders',
        dataDirectory: 'Code - Insiders',
        installDirectory: 'Microsoft VS Code Insiders',
        appName: 'Visual Studio Code - Insiders',
        targetPopulation: 'insider',
    },
};

export function resolveVSCodeFilters(options, dependencies = {}) {
    const env = dependencies.env ?? process.env;
    const platform = dependencies.platform ?? process.platform;
    const home = dependencies.home ?? homedir();
    const readFile = dependencies.readFile ?? readFileSync;
    const execute = dependencies.execute ?? executeCommand;
    const channel = CHANNELS[options.vscodeChannel];

    if (!channel) {
        throw new Error(`Unsupported VS Code channel: ${options.vscodeChannel}`);
    }

    const dataPath = getVSCodeDataPath(channel.dataDirectory, env, platform, home);
    const statePath = path.join(dataPath, 'User', 'globalStorage', 'storage.json');
    const state = readJsonFile(statePath, readFile, 'VS Code state');
    const machineId = state['telemetry.machineId'];
    if (typeof machineId !== 'string' || machineId.length === 0) {
        throw new Error(`VS Code machine ID was not found in ${statePath}.`);
    }
    const devDeviceId = state['telemetry.devDeviceId'];
    if (typeof devDeviceId !== 'string' || devDeviceId.length === 0) {
        throw new Error(`VS Code dev device ID was not found in ${statePath}.`);
    }

    const build = getVSCodeBuild(channel.command, execute);
    const extensionVersion = options.extensionVersion ??
        (options.extensionName === 'vscode-core'
            ? '999999.0'
            : findExtensionVersion(channel.command, options.extensionName, execute));
    if (!extensionVersion) {
        throw new Error(
            `Extension "${options.extensionName}" is not installed in VS Code ${options.vscodeChannel}. ` +
                'Pass --extension-version to supply its version explicitly.',
        );
    }
    const language = options.language ?? getVSCodeLanguage(dataPath, env, readFile);
    const releaseDate =
        options.releaseDate ??
        getVSCodeReleaseDate(channel, build.commit, env, platform, home, readFile);

    const filters = {
        'X-MSEdge-Market': '',
        'X-FD-Corpnet': '',
        'X-VSCode-AppVersion': trimVersionSuffix(build.version),
        'X-VSCode-Build': channel.appName,
        'X-MSEdge-ClientId': machineId,
        'X-VSCode-DevDeviceId': devDeviceId.replace(/^\uFEFF/, ''),
        'X-VSCode-ExtensionName': options.extensionName,
        'X-VSCode-ExtensionVersion': trimVersionSuffix(extensionVersion),
        'X-VSCode-Language': language,
        'X-VSCode-TargetPopulation': options.targetPopulation ?? channel.targetPopulation,
        'X-VSCode-Platform': getVSCodePlatform(platform),
        'X-VSCode-ReleaseDate': formatReleaseDate(releaseDate),
        'X-VSCode-WindowKind': options.windowKind ?? 'editor',
    };

    return filters;
}

function getVSCodePlatform(platform) {
    const platforms = {
        win32: 'windows',
        darwin: 'mac',
        linux: 'linux',
    };
    return platforms[platform] ?? platform;
}

function getVSCodeReleaseDate(channel, commit, env, platform, home, readFile) {
    const windowsInstallRoots = [
        env.LOCALAPPDATA &&
            path.join(env.LOCALAPPDATA, 'Programs', channel.installDirectory),
        env.ProgramFiles && path.join(env.ProgramFiles, channel.installDirectory),
    ].filter(Boolean);
    const candidates =
        platform === 'win32'
            ? windowsInstallRoots.flatMap((root) => [
                  commit && path.join(root, commit.slice(0, 10), 'resources', 'app', 'product.json'),
                  path.join(root, 'resources', 'app', 'product.json'),
              ])
            : platform === 'darwin'
              ? [
                    path.join(
                        '/Applications',
                        `${channel.appName}.app`,
                        'Contents',
                        'Resources',
                        'app',
                        'product.json',
                    ),
                    path.join(
                        home,
                        'Applications',
                        `${channel.appName}.app`,
                        'Contents',
                        'Resources',
                        'app',
                        'product.json',
                    ),
                ]
              : [
                    path.join('/usr', 'share', channel.command, 'resources', 'app', 'product.json'),
                    path.join('/usr', 'lib', channel.command, 'resources', 'app', 'product.json'),
                ];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        try {
            const product = JSON.parse(readFile(candidate, 'utf8'));
            if (typeof product.date === 'string') {
                return product.date;
            }
        } catch {
            // Installation locations vary; try the next standard location.
        }
    }
    return '';
}

function formatReleaseDate(iso) {
    const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2})/.exec(iso);
    return match ? match.slice(1, 5).join('') : '';
}

function getVSCodeDataPath(directory, env, platform, home) {
    if (platform === 'win32') {
        if (!env.APPDATA) {
            throw new Error('APPDATA is not set; unable to locate VS Code state.');
        }
        return path.join(env.APPDATA, directory);
    }
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', directory);
    }
    return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), directory);
}

function readJsonFile(filePath, readFile, description) {
    let contents;
    try {
        contents = readFile(filePath, 'utf8');
    } catch (error) {
        throw new Error(`Unable to read ${description} at ${filePath}: ${formatError(error)}`);
    }
    try {
        return JSON.parse(contents);
    } catch (error) {
        throw new Error(`Invalid JSON in ${description} at ${filePath}: ${formatError(error)}`);
    }
}

function getVSCodeBuild(command, execute) {
    let output;
    try {
        output = execute(command, ['--version']);
    } catch (error) {
        throw new Error(`Unable to run ${command} --version: ${formatError(error)}`);
    }
    const lines = output.split(/\r?\n/);
    const version = lines[0]?.trim();
    if (!version) {
        throw new Error(`${command} --version did not return a version.`);
    }
    return { version, commit: lines[1]?.trim() };
}

function findExtensionVersion(command, extensionName, execute) {
    let output;
    try {
        output = execute(command, ['--list-extensions', '--show-versions']);
    } catch (error) {
        throw new Error(`Unable to list ${command} extensions: ${formatError(error)}`);
    }
    const prefix = `${extensionName.toLowerCase()}@`;
    const match = output
        .split(/\r?\n/)
        .find((line) => line.trim().toLowerCase().startsWith(prefix));
    return match?.trim().slice(prefix.length);
}

function getVSCodeLanguage(dataPath, env, readFile) {
    if (env.VSCODE_NLS_CONFIG) {
        try {
            const config = JSON.parse(env.VSCODE_NLS_CONFIG);
            if (typeof config.locale === 'string' && config.locale.length > 0) {
                return config.locale;
            }
        } catch {
            // Fall through to persisted and operating-system locale detection.
        }
    }

    const argvPath = path.join(dataPath, 'argv.json');
    try {
        const argv = JSON.parse(stripJsonComments(readFile(argvPath, 'utf8')));
        if (typeof argv.locale === 'string' && argv.locale.length > 0) {
            return argv.locale;
        }
    } catch {
        // argv.json is optional and may contain comments, which JSON.parse does not accept.
    }

    return Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0];
}

function trimVersionSuffix(version) {
    return version.split(/\-[a-zA-Z0-9]+$/)[0];
}

function executeCommand(command, args) {
    if (process.platform === 'win32') {
        return execFileSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d',
            '/s',
            '/c',
            `${command} ${args.join(' ')}`,
        ], {
            encoding: 'utf8',
            windowsHide: true,
        });
    }
    return execFileSync(command, args, {
        encoding: 'utf8',
        windowsHide: true,
    });
}

function stripJsonComments(input) {
    let result = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < input.length; index += 1) {
        const current = input[index];
        const next = input[index + 1];
        if (lineComment) {
            if (current === '\n') {
                lineComment = false;
                result += current;
            }
            continue;
        }
        if (blockComment) {
            if (current === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (!inString && current === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (!inString && current === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        result += current;
        if (inString && current === '\\' && !escaped) {
            escaped = true;
            continue;
        }
        if (current === '"' && !escaped) {
            inString = !inString;
        }
        escaped = false;
    }
    return result;
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
