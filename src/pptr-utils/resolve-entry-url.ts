import { buildEntryCandidates, ResolutionFailureKind } from './entry-candidates';
import { classifyError, FetchInit, FetchLike, isHtml, readHead, RequestFailure, ResponseLike } from './entry-http';
import { findDocumentRedirect } from './document-redirect';
import { parseProxyArg, ProxyDispatcherFactory, redactSecrets, undiciProxyDispatcher } from './proxy-dispatcher';
import { ScanDeadline } from './scan-deadline';

export type { FetchInit, FetchLike, ResponseLike } from './entry-http';

export interface ResolveEntryOptions {
    deadline: ScanDeadline;
    /** User agent of the browser that will crawl, so servers answer the resolver the same way. */
    userAgent?: string;
    /** Chromium flags; a `--proxy-server=` flag is mirrored for the resolver's requests. */
    extraChromiumArgs?: readonly string[];
    fetchImpl?: FetchLike;
    createProxyDispatcher?: ProxyDispatcherFactory;
    log?: (message: string) => void;
    requestTimeoutMs?: number;
    /** Cap for the whole resolution, so it never eats a meaningful share of the crawl budget. */
    totalTimeoutMs?: number;
    maxHops?: number;
}

export interface EntryResolution {
    requestedUrl: string;
    finalUrl: string;
    /** Every URL visited, starting with the requested one. */
    hops: string[];
    /** Status of the last response, null when the last request got no response. */
    status: number | null;
    failure: { kind: ResolutionFailureKind; message: string } | null;
    hopLimitReached: boolean;
    proxied: boolean;
    /** Ordered URLs for the browser to try. */
    candidates: string[];
}

export const FALLBACK_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

class EntryResolver {
    private readonly fetchImpl: FetchLike | null;
    private readonly log: (message: string) => void;
    private readonly startedAt = Date.now();
    private dispatcher: object | undefined;
    private secrets: string[] = [];

    constructor(private readonly options: ResolveEntryOptions) {
        this.fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? (url, init) => fetch(url, init) : null);
        const log = options.log ?? console.log;
        this.log = message => log(redactSecrets(message, this.secrets));
    }

    private setUpProxy(): void {
        const proxy = parseProxyArg(this.options.extraChromiumArgs);
        if (proxy === null) {
            return;
        }
        if (proxy === 'unsupported') {
            this.log('Entry pre-resolution ran without proxy: proxy flag format is not supported by the resolver');
            return;
        }
        this.secrets = proxy.secrets;
        const dispatcher = (this.options.createProxyDispatcher ?? undiciProxyDispatcher)(proxy);
        if (dispatcher === null) {
            this.log('Entry pre-resolution ran without proxy: no proxy-capable HTTP client available');
            return;
        }
        this.dispatcher = dispatcher;
    }

    private timeoutMs(): number {
        const total = this.options.totalTimeoutMs ?? 20000;
        const leftForResolution = total - (Date.now() - this.startedAt);
        return Math.min(this.options.requestTimeoutMs ?? 8000, leftForResolution, this.options.deadline.remainingMs());
    }

    /** One request with its own timeout; `consume` runs while the timer still guards the body. */
    private async request<T>(fetchImpl: FetchLike, url: string, method: 'HEAD' | 'GET', consume: (r: ResponseLike) => Promise<T>): Promise<T> {
        const timeoutMs = this.timeoutMs();
        if (timeoutMs <= 0) {
            throw new RequestFailure('timeout', 'resolution budget exhausted');
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        try {
            const headers = {
                'user-agent': this.options.userAgent || FALLBACK_USER_AGENT,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            };
            const init: FetchInit = { method, headers, redirect: 'manual', signal: controller.signal };
            if (this.dispatcher) {
                init.dispatcher = this.dispatcher;
            }
            return await consume(await fetchImpl(url, init));
        } catch (error) {
            throw error instanceof RequestFailure ? error : classifyError(error, timedOut);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Status, Location and (for HTML pages) the first bytes of the document. */
    private async probe(fetchImpl: FetchLike, url: string, wantDocument: boolean) {
        const summarize = async (response: ResponseLike, method: 'HEAD' | 'GET') => {
            const location = response.headers.get('location');
            const sniff = method === 'GET' && wantDocument && response.status >= 200 && response.status < 300 && isHtml(response);
            const document = sniff && response.body ? await readHead(response.body) : null;
            if (!document && response.body) {
                await response.body.cancel();
            }
            return { status: response.status, location, document, html: isHtml(response) };
        };
        let head: Awaited<ReturnType<typeof summarize>> | null = null;
        try {
            head = await this.request(fetchImpl, url, 'HEAD', r => summarize(r, 'HEAD'));
        } catch (error) {
            // Plenty of servers mishandle HEAD, so a GET gets the final word. Timeouts and DNS
            // failures are exceptions: they do not depend on the method, so a GET would only
            // spend more of the budget on the same answer.
            if (error instanceof RequestFailure && (error.kind === 'timeout' || error.kind === 'dns')) {
                throw error;
            }
            this.log(`HEAD ${url} failed, retrying with GET`);
        }
        const needsGet = head === null || head.status === 405 || head.status === 403
            || (wantDocument && head.html && head.status >= 200 && head.status < 300);
        return needsGet ? this.request(fetchImpl, url, 'GET', r => summarize(r, 'GET')) : head;
    }

    async resolve(requestedUrl: string): Promise<EntryResolution> {
        const maxHops = this.options.maxHops ?? 10;
        const hops = [requestedUrl];
        const result = (finalUrl: string, extra: Partial<EntryResolution>): EntryResolution => {
            const base = { requestedUrl, finalUrl, hops, status: null, failure: null, hopLimitReached: false, proxied: this.dispatcher !== undefined };
            const resolution = { ...base, ...extra };
            return { ...resolution, candidates: buildEntryCandidates(requestedUrl, resolution) };
        };
        const fetchImpl = this.fetchImpl;
        if (fetchImpl === null) {
            this.log('Entry pre-resolution skipped: no fetch implementation available');
            return result(requestedUrl, { failure: { kind: 'other', message: 'fetch unavailable' } });
        }
        this.setUpProxy();
        let current = requestedUrl;
        let documentHopUsed = false;
        for (;;) {
            let probe: Awaited<ReturnType<EntryResolver['probe']>>;
            try {
                probe = await this.probe(fetchImpl, current, !documentHopUsed);
            } catch (error) {
                const failure = error instanceof RequestFailure ? error : classifyError(error, false);
                this.log(`Entry pre-resolution of ${current} failed (${failure.kind}): ${failure.message}`);
                return result(current, { failure: { kind: failure.kind, message: redactSecrets(failure.message, this.secrets) } });
            }
            let next: string | null = null;
            if (REDIRECT_STATUSES.has(probe.status) && probe.location) {
                next = new URL(probe.location, current).href;
            } else if (probe.document !== null) {
                next = findDocumentRedirect(probe.document, current);
                documentHopUsed = documentHopUsed || next !== null;
            }
            if (next === null) {
                return result(current, { status: probe.status });
            }
            if (hops.length - 1 >= maxHops) {
                this.log(`Entry pre-resolution stopped after ${maxHops} redirects at ${current}`);
                return result(current, { status: probe.status, hopLimitReached: true });
            }
            hops.push(next);
            current = next;
        }
    }
}

/**
 * Follows the entry URL's redirects with a lightweight HTTP client before the browser starts,
 * so the crawl can start from where the site actually lives and has alternatives to try when
 * the first host does not answer. Never throws; failures are described in the result.
 */
export const resolveEntryUrl = (url: string, options: ResolveEntryOptions): Promise<EntryResolution> =>
    new EntryResolver(options).resolve(url);
