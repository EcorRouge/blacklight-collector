import { classifyError, FetchInit, FetchLike, readHead } from './entry-http';
import { parseProxyArg, ProxyDispatcherFactory, redactSecrets, undiciProxyDispatcher } from './proxy-dispatcher';
import { FALLBACK_USER_AGENT } from './resolve-entry-url';
import { ScanDeadline } from './scan-deadline';

/**
 * Small GET client for page discovery (error pages, robots.txt, sitemaps). Every request is
 * bounded in time and size: discovery only runs for sites that are already failing, so it
 * must not let a slow or huge response eat the crawl budget.
 */

export interface BoundedFetchOptions {
    deadline: ScanDeadline;
    userAgent?: string;
    /** Chromium flags; a `--proxy-server=` flag is mirrored so requests leave from the browser's vantage point. */
    extraChromiumArgs?: readonly string[];
    fetchImpl?: FetchLike;
    createProxyDispatcher?: ProxyDispatcherFactory;
    log?: (message: string) => void;
    requestTimeoutMs?: number;
    /** Cap for all requests made through one fetcher. */
    totalTimeoutMs?: number;
    maxBytes?: number;
}

export interface FetchedText {
    /** URL the body came from, after redirects. */
    url: string;
    status: number;
    text: string;
}

/** Resolves to null whenever the body could not be read; never throws. */
export type TextFetcher = (url: string) => Promise<FetchedText | null>;

export const MAX_DISCOVERY_BYTES = 512 * 1024;

const proxyDispatcher = (options: BoundedFetchOptions, log: (message: string) => void): { dispatcher?: object; secrets: string[] } => {
    const proxy = parseProxyArg(options.extraChromiumArgs);
    if (proxy === null) {
        return { secrets: [] };
    }
    if (proxy === 'unsupported') {
        log('Page discovery requests run without proxy: proxy flag format is not supported');
        return { secrets: [] };
    }
    const dispatcher = (options.createProxyDispatcher ?? undiciProxyDispatcher)(proxy);
    if (dispatcher === null) {
        log('Page discovery requests run without proxy: no proxy-capable HTTP client available');
        return { secrets: proxy.secrets };
    }
    return { dispatcher, secrets: proxy.secrets };
};

export const createTextFetcher = (options: BoundedFetchOptions): TextFetcher => {
    const fetchImpl: FetchLike | null = options.fetchImpl ?? (typeof fetch === 'function' ? (url, init) => fetch(url, init) : null);
    const rawLog = options.log ?? console.log;
    let secrets: string[] = [];
    const log = (message: string) => rawLog(redactSecrets(message, secrets));
    const proxy = proxyDispatcher(options, log);
    secrets = proxy.secrets;
    const startedAt = Date.now();

    const timeoutMs = () =>
        Math.min(
            options.requestTimeoutMs ?? 5000,
            (options.totalTimeoutMs ?? 20000) - (Date.now() - startedAt),
            options.deadline.remainingMs()
        );

    return async url => {
        const budget = timeoutMs();
        if (fetchImpl === null || budget <= 0) {
            return null;
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, budget);
        try {
            const init: FetchInit = {
                method: 'GET',
                headers: { 'user-agent': options.userAgent || FALLBACK_USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
                redirect: 'follow',
                signal: controller.signal
            };
            if (proxy.dispatcher) {
                init.dispatcher = proxy.dispatcher;
            }
            const response = await fetchImpl(url, init);
            const text = response.body ? await readHead(response.body, options.maxBytes ?? MAX_DISCOVERY_BYTES) : '';
            return { url: response.url || url, status: response.status, text };
        } catch (error) {
            const failure = classifyError(error, timedOut);
            log(`Discovery request ${url} failed (${failure.kind}): ${failure.message}`);
            return null;
        } finally {
            clearTimeout(timer);
        }
    };
};
