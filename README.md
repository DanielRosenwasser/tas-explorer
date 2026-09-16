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
