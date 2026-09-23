# TAS value CLI

A small command-line wrapper around Microsoft's [`tas-client`](https://github.com/microsoft/tas-client/tree/main/tas-client) for querying a treatment variable.

## Requirements

- Node.js 22 or newer

## Install

From this directory:

```console
npm install
```

```console
npm run tas -- get <config-id> <variable-name>
```

## Development

Install dependencies with `pnpm install` (the lockfile pins the resolved TypeScript nightly).
JavaScript in `src` and `test` is strictly type-checked using JSDoc, without emitting files:

```console
pnpm run typecheck
pnpm run check
pnpm test
```

`check` runs type checking. The compiler dependency uses `typescript@next`;
run `pnpm update typescript` to move to a newer nightly.

For VS Code, install the recommended **TypeScript (Native Preview)** extension. Workspace
settings enable the native language service used by TypeScript 7 nightly builds, rather
than VS Code's bundled TypeScript service. Both use the project's `jsconfig.json`.

## Web UI

Start a local treatment explorer in server mode:

```console
npm run tas -- --web
```

Open the printed URL (by default `http://127.0.0.1:3000`) in your browser. The server stays
running until you press Ctrl+C. It binds only to IPv4 loopback, not your network interfaces.
No additional dependencies, CDN assets, or browser frameworks are used.

Use `--port` to choose a port, or `--port 0` to select an available port. Existing query options
become editable defaults in the UI; supplying a `get` command also pre-fills the config and variable:

```console
npm run tas -- get vscode feature.enabled --web --vscode insiders --port 8080
```

The UI supports the same profile, caller, language, target, window kind, release date, endpoint,
and custom header overrides as the CLI. It shows the assigned value and its type, copyable
response JSON, elapsed query time, and the resolved request headers. Missing variables and
request errors are shown explicitly; outbound web queries time out after 30 seconds.

VS Code identity is read on each query, not at server startup. Disable **Use VS Code identity**
(or start with `--no-vscode-filters`) for raw requests. Queries send headers, including machine
and device IDs when enabled, to the selected endpoint. Request headers displayed in the UI may
contain these identifiers; review them before sharing. The local API rejects cross-origin requests.

## Usage

The CLI defaults to VS Code's `https://default.exp-tas.com/vscode/ab` endpoint and automatically
calculates the same generic headers as `vscode-tas-client`:

- VS Code version and build
- persisted VS Code machine ID
- persisted VS Code developer device ID
- display language
- stable/Insiders target population
- platform, release date, and window kind

By default the caller is `vscode-core` with extension version `999999.0`, exactly like VS Code's
core assignment provider. `telemetry.devDeviceId` is always sent as `X-VSCode-DevDeviceId`.

Query a VS Code core treatment without specifying an extension:

```console
npm run tas -- get vscode feature.enabled
```

Stable VS Code is used by default. To use the Insiders identity, version, extension installation,
and target population:

```console
npm run tas -- get vscode feature.enabled --vscode insiders
```

Use `--filter key=value` to add a header or override an automatically calculated value. Use
`--no-vscode-filters` for a raw request. The endpoint can be changed with `--endpoint` or
`TAS_ENDPOINT`.

To emulate the older extension-host `vscode-tas-client` caller instead, override the extension ID.
Its installed version is detected, or can be supplied explicitly:

```console
npm run tas -- get vscode feature.enabled --extension ms-python.python
```

By default, the command prints only the value, which is convenient for scripts. Use `--json` for a structured result:

```console
npm run tas -- get vscode feature.enabled --json
```

```json
{"configId":"vscode","variable":"feature.enabled","value":true}
```

Exit codes are `0` for success, `1` for request/runtime errors, `2` for invalid arguments, and `3` when the treatment variable is not found.
