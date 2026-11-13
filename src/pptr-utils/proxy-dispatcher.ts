/**
 * Routes the entry pre-resolution through the same proxy the browser uses, so redirects are
 * observed from the same network vantage point. The proxy URL carries credentials, so nothing
 * here ever puts it (or any part of it) into a log message.
 */

const PROXY_FLAG = '--proxy-server=';

/** A proxy the resolver can use: credentials separated from the endpoint. */
export interface ProxySettings {
    /** Proxy endpoint without credentials. */
    uri: string;
    /** Value for the Proxy-Authorization header, when the proxy URL carried credentials. */
    token?: string;
    /** Every substring that must be scrubbed from log output. */
    secrets: string[];
}

/** Builds an undici dispatcher for the proxy, or returns null when that is not possible. */
export type ProxyDispatcherFactory = (proxy: ProxySettings) => object | null;

type ProxyAgentConstructor = new (options: { uri: string; token?: string }) => object;

const isConstructor = (value: unknown): value is ProxyAgentConstructor => typeof value === 'function';

/**
 * Chromium accepts `scheme://user:pass@host:port`, `host:port` (implying http) and per-scheme
 * lists such as `http=a:1;https=b:2`. Only a single http(s) proxy can be mirrored by fetch.
 * Returns null when there is no proxy flag, or `unsupported` when the flag cannot be mirrored.
 */
export const parseProxyArg = (chromiumArgs: readonly string[] = []): ProxySettings | 'unsupported' | null => {
    const flag = chromiumArgs.find(arg => arg.startsWith(PROXY_FLAG));
    if (!flag) {
        return null;
    }
    const raw = flag.slice(PROXY_FLAG.length).trim();
    if (raw === '' || raw.includes(';') || raw.includes('=')) {
        return 'unsupported';
    }
    let url: URL;
    try {
        url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    } catch (error) {
        return 'unsupported';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'unsupported';
    }
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const secrets = [raw, url.href, url.host, url.hostname, url.username, url.password, username, password].filter(s => s !== '');
    const token = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
    url.username = '';
    url.password = '';
    return { uri: url.origin, token, secrets: token ? [...secrets, token] : secrets };
};

/**
 * Node 20 ships fetch on top of undici but does not expose undici's ProxyAgent. Use the
 * undici package when it happens to be installed; otherwise the caller resolves unproxied.
 */
export const undiciProxyDispatcher: ProxyDispatcherFactory = proxy => {
    let undici: unknown;
    try {
        undici = require('undici');
    } catch (error) {
        return null;
    }
    if (typeof undici !== 'object' || undici === null || !('ProxyAgent' in undici)) {
        return null;
    }
    const ProxyAgent = undici.ProxyAgent;
    if (!isConstructor(ProxyAgent)) {
        return null;
    }
    return new ProxyAgent(proxy.token ? { uri: proxy.uri, token: proxy.token } : { uri: proxy.uri });
};

/** Replaces every credential-bearing fragment of the proxy with a placeholder. */
export const redactSecrets = (message: string, secrets: readonly string[]): string =>
    [...secrets].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join('[redacted]'), message);
