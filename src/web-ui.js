/// <reference lib="dom" />
/** @import { QueryResult } from './web-server.js' */

/** @template {Element} T @param {string} selector @param {{ new(): T }} type @returns {T} */
function getElement(selector, type) {
    const element = document.querySelector(selector);
    if (!(element instanceof type)) {
        throw new Error(`Missing UI element: ${selector}`);
    }
    return element;
}

const form = getElement('#query-form', HTMLFormElement);
const fields = getElement('#query-fields', HTMLFieldSetElement);
const submitLabel = getElement('#submit-query span', HTMLSpanElement);
const badge = getElement('#status-badge', HTMLSpanElement);
const feedback = getElement('#feedback', HTMLDivElement);
const emptyState = getElement('#empty-state', HTMLDivElement);
const resultContent = getElement('#result-content', HTMLDivElement);
const resultPanel = getElement('.result-panel', HTMLElement);
const copyButton = getElement('#copy-result', HTMLButtonElement);
/** @type {string | undefined} */
let responseJson;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Record<string, string>} */
function isHeaders(value) {
    return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** @param {unknown} value @returns {value is QueryResult} */
function isResult(value) {
    return isRecord(value) && typeof value.configId === 'string' && typeof value.variable === 'string' &&
        typeof value.durationMs === 'number' && 'value' in value && isHeaders(value.filters);
}

/** @param {unknown} error */
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

/** @param {string} message @param {string} state */
function showFeedback(message, state) {
    feedback.textContent = message;
    feedback.dataset.state = state;
    feedback.hidden = !message;
}

/** @param {string} label @param {string} state */
function setStatus(label, state) {
    badge.textContent = label;
    badge.dataset.state = state;
}

/** @param {string} url @param {RequestInit} [options] @returns {Promise<unknown>} */
async function requestJson(url, options) {
    const response = await fetch(url, options);
    /** @type {unknown} */
    const body = await response.json();
    if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `Request failed with HTTP ${response.status}.`);
    }
    return body;
}

function buildArgs() {
    const data = new FormData(form);
    /** @param {string} name */
    const text = (name) => {
        const value = data.get(name);
        if (typeof value !== 'string') {
            throw new Error(`Missing query field: ${name}`);
        }
        return value.trim();
    };
    const args = ['get', text('configId'), text('variableName')];
    const options = {
        endpoint: '--endpoint',
        vscodeChannel: '--vscode',
        windowKind: '--window-kind',
        extensionName: '--extension',
        extensionVersion: '--extension-version',
        language: '--language',
        targetPopulation: '--target',
        releaseDate: '--release-date',
    };
    for (const [name, option] of Object.entries(options)) {
        const value = text(name);
        if (value) {
            args.push(option, value);
        }
    }
    if (!data.has('vscodeFilters')) {
        args.push('--no-vscode-filters');
    }
    for (const line of text('filters').split(/\r?\n/)) {
        if (line.trim()) {
            args.push('--filter', line.trim());
        }
    }
    return args;
}

/** @param {QueryResult} result */
function renderResult(result) {
    const output = { configId: result.configId, variable: result.variable, value: result.value };
    responseJson = JSON.stringify(output, null, 2);
    const type = result.value === null ? 'null' : Array.isArray(result.value) ? 'array' : typeof result.value;
    getElement('#result-path', HTMLElement).textContent = `${result.configId} / ${result.variable}`;
    getElement('#duration', HTMLElement).textContent = `${result.durationMs} ms`;
    getElement('#value-type', HTMLElement).textContent = type;
    getElement('#result-value', HTMLElement).textContent = JSON.stringify(result.value, null, 2);
    getElement('#result-json', HTMLElement).textContent = responseJson;
    const headers = Object.entries(result.filters);
    getElement('#header-count', HTMLElement).textContent = `(${headers.length})`;
    const list = getElement('#request-headers', HTMLDListElement);
    list.replaceChildren();
    for (const [key, value] of headers) {
        const term = document.createElement('dt');
        const description = document.createElement('dd');
        term.textContent = key;
        description.textContent = value === '' ? '(empty)' : value;
        list.append(term, description);
    }
    if (!headers.length) {
        const description = document.createElement('dd');
        description.textContent = 'No custom or automatic headers.';
        list.append(description);
    }
    emptyState.hidden = true;
    resultContent.hidden = false;
    copyButton.textContent = 'Copy JSON';
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        // Disabled fields are omitted from FormData, so capture arguments first.
        const args = buildArgs();
        fields.disabled = true;
        submitLabel.textContent = 'Querying...';
        resultPanel.setAttribute('aria-busy', 'true');
        setStatus('Querying', 'loading');
        showFeedback('Resolving request headers and querying TAS...', 'loading');
        resultContent.hidden = true;
        emptyState.hidden = true;
        responseJson = undefined;
        const result = await requestJson('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args }),
        });
        if (!isResult(result)) {
            throw new Error('The server returned an invalid treatment result.');
        }
        renderResult(result);
        setStatus('Success', 'success');
        showFeedback('', 'success');
    } catch (error) {
        setStatus('Failed', 'error');
        showFeedback(formatError(error), 'error');
    } finally {
        fields.disabled = false;
        submitLabel.textContent = 'Query treatment';
        resultPanel.setAttribute('aria-busy', 'false');
    }
});

copyButton.addEventListener('click', async () => {
    if (responseJson === undefined) {
        return;
    }
    try {
        await navigator.clipboard.writeText(responseJson);
        copyButton.textContent = 'Copied!';
    } catch (error) {
        showFeedback(`Could not copy JSON: ${formatError(error)}. Select the response text to copy manually.`, 'error');
    }
});

async function initialize() {
    try {
        const defaults = await requestJson('/api/defaults');
        if (!isRecord(defaults) || !isHeaders(defaults.filters) || typeof defaults.vscodeFilters !== 'boolean') {
            throw new Error('The server returned invalid query defaults.');
        }
        for (const element of Array.from(form.elements)) {
            if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
                continue;
            }
            if (element.name === 'filters') {
                element.value = Object.entries(defaults.filters).map(([key, value]) => `${key}=${value}`).join('\n');
            } else if (element instanceof HTMLInputElement && element.name === 'vscodeFilters') {
                element.checked = defaults.vscodeFilters;
            } else {
                const value = defaults[element.name];
                if (element.name && typeof value === 'string') {
                    element.value = value;
                }
            }
        }
        fields.disabled = false;
    } catch (error) {
        setStatus('Unavailable', 'error');
        showFeedback(`Unable to load server defaults: ${formatError(error)}. Restart the server and reload this page.`, 'error');
        emptyState.hidden = true;
    }
}

initialize();
