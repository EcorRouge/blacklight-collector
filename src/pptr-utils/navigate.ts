import { PuppeteerLifeCycleEvent, TimeoutError } from 'puppeteer';
import { ScanDeadline } from './scan-deadline';

/** The parts of a puppeteer HTTPResponse that navigation decisions depend on. */
export interface NavigationResponse {
    status(): number;
}

/** The parts of a puppeteer CDPSession needed to abort a pending load. */
export interface LoadStopper {
    send(method: 'Page.stopLoading'): Promise<unknown>;
    detach(): Promise<void>;
}

/**
 * The parts of a puppeteer Page that navigation needs. Kept minimal so the retry and
 * timeout policy can be exercised with a fake page as well as a real one.
 */
export interface NavigablePage<R extends NavigationResponse> {
    goto(url: string, options: { timeout: number; waitUntil: PuppeteerLifeCycleEvent }): Promise<R | null>;
    createCDPSession(): Promise<LoadStopper>;
}

export interface NavigationOptions {
    waitUntil: PuppeteerLifeCycleEvent;
    /** Cap for a single goto. */
    navigationTimeoutMs: number;
    /** Caller-supplied upper bound, kept for backwards compatibility. */
    defaultTimeout: number;
    /** Attempts for network/timeout errors. HTTP statuses follow their own, stricter policy. */
    maxRetries: number;
    deadline: ScanDeadline;
    retryBackoffMs?: number;
    log?: (message: string) => void;
}

export type NavigationOutcome<R> =
    | { kind: 'success'; response: R; gotoCalls: number }
    | { kind: 'http_error'; response: R; gotoCalls: number }
    | { kind: 'network_error'; response: null; error: Error; gotoCalls: number }
    | { kind: 'deadline'; response: R | null; gotoCalls: number };

export type StatusPolicy = 'success' | 'permanent' | 'retry_once';

/** Statuses that will not change by asking again a second later. */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 404, 405, 410, 451]);

/**
 * 2xx and 304 are usable pages. Permanent client errors are not retried: repeating them only
 * burns scan time. Everything else (403 bot walls, 429 rate limits, 5xx origin trouble and any
 * unusual status) gets exactly one more chance because it is frequently transient.
 */
export const classifyStatus = (status: number): StatusPolicy => {
    if ((status >= 200 && status < 300) || status === 304) {
        return 'success';
    }
    return PERMANENT_STATUSES.has(status) ? 'permanent' : 'retry_once';
};

/** Upper bound on how long we wait for the browser to acknowledge a stop on a wedged page. */
const STOP_LOAD_TIMEOUT_MS = 2000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type AttemptResult<R> = { kind: 'response'; response: R | null } | { kind: 'error'; error: Error };

class Navigator<R extends NavigationResponse> {
    gotoCalls = 0;
    private readonly log: (message: string) => void;

    constructor(private readonly page: NavigablePage<R>, private readonly url: string, private readonly options: NavigationOptions) {
        this.log = options.log ?? console.log;
    }

    /**
     * Effective timeout for one goto. Zero must never reach puppeteer, where it means "wait
     * forever", so callers check the deadline first and this floors the value at 1 ms.
     */
    private timeoutMs(): number {
        const { navigationTimeoutMs, defaultTimeout, deadline } = this.options;
        return Math.max(1, Math.min(navigationTimeoutMs, defaultTimeout, deadline.remainingMs()));
    }

    /**
     * A goto that rejects (timeout or otherwise) leaves the browser still loading the page, and
     * the next goto would race with it. Stop the load so attempts never overlap.
     *
     * This uses the DevTools Page.stopLoading command rather than evaluating window.stop():
     * while a navigation is pending the frame has no usable JS context, so an evaluate stalls
     * until the navigation resolves on its own, which is exactly what we are trying to avoid.
     */
    private async stopPendingLoad(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const stop = async () => {
            const session = await this.page.createCDPSession();
            try {
                await session.send('Page.stopLoading');
            } finally {
                await session.detach();
            }
        };
        try {
            await Promise.race([
                stop(),
                new Promise<void>(resolve => {
                    timer = setTimeout(resolve, STOP_LOAD_TIMEOUT_MS);
                })
            ]);
        } catch (error) {
            this.log(`Could not stop pending load of ${this.url}: ${error.message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    private async goto(waitUntil: PuppeteerLifeCycleEvent): Promise<AttemptResult<R>> {
        this.gotoCalls++;
        try {
            const response = await this.page.goto(this.url, { timeout: this.timeoutMs(), waitUntil });
            return { kind: 'response', response };
        } catch (error) {
            await this.stopPendingLoad();
            return { kind: 'error', error: error instanceof Error ? error : new Error(String(error)) };
        }
    }

    /**
     * One attempt: the configured lifecycle event first and, only if that timed out, a cheaper
     * domcontentloaded load. The fallback starts after the first goto has settled and its load
     * was stopped, so two navigations are never in flight together.
     */
    private async attempt(): Promise<AttemptResult<R>> {
        const first = await this.goto(this.options.waitUntil);
        const canFallBack = first.kind === 'error' && first.error instanceof TimeoutError && this.options.waitUntil !== 'domcontentloaded';
        if (!canFallBack || this.options.deadline.isExpired()) {
            return first;
        }
        this.log(`Navigation to ${this.url} timed out, retrying with domcontentloaded`);
        return this.goto('domcontentloaded');
    }

    async run(): Promise<NavigationOutcome<R>> {
        const { deadline, maxRetries } = this.options;
        const backoffMs = this.options.retryBackoffMs ?? 1000;
        let lastResponse: R | null = null;
        let lastError = new Error(`No navigation attempted for ${this.url}`);
        let retriedStatus = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (deadline.isExpired()) {
                return { kind: 'deadline', response: lastResponse, gotoCalls: this.gotoCalls };
            }
            const result = await this.attempt();
            if (result.kind === 'error' || result.response === null) {
                lastResponse = null;
                lastError = result.kind === 'error' ? result.error : new Error(`Navigation to ${this.url} returned no response`);
                this.log(`Attempt ${attempt}/${maxRetries} for ${this.url} failed: ${lastError.message}`);
                continue;
            }

            const response = result.response;
            lastResponse = response;
            const status = response.status();
            const policy = classifyStatus(status);
            switch (policy) {
                case 'success':
                    return { kind: 'success', response, gotoCalls: this.gotoCalls };
                case 'permanent':
                    this.log(`HTTP status ${status} for ${this.url} will not change on retry, skipping`);
                    return { kind: 'http_error', response, gotoCalls: this.gotoCalls };
                case 'retry_once':
                    if (retriedStatus || attempt === maxRetries) {
                        this.log(`HTTP status ${status} for ${this.url} after retry, skipping`);
                        return { kind: 'http_error', response, gotoCalls: this.gotoCalls };
                    }
                    if (deadline.remainingMs() <= backoffMs) {
                        return { kind: 'deadline', response, gotoCalls: this.gotoCalls };
                    }
                    this.log(`HTTP status ${status} for ${this.url}, retrying once in ${backoffMs} ms`);
                    retriedStatus = true;
                    await sleep(backoffMs);
                    break;
                default: {
                    const unreachable: never = policy;
                    throw new Error(`Unhandled status policy ${unreachable}`);
                }
            }
        }

        if (lastResponse !== null) {
            return { kind: 'http_error', response: lastResponse, gotoCalls: this.gotoCalls };
        }
        return { kind: 'network_error', response: null, error: lastError, gotoCalls: this.gotoCalls };
    }
}

/**
 * Navigates to url within the per-navigation cap and the shared scan deadline, applying the
 * status-aware retry policy. Never throws for navigation failures; the outcome says what happened.
 */
export const navigateWithinBudget = <R extends NavigationResponse>(
    page: NavigablePage<R>,
    url: string,
    options: NavigationOptions
): Promise<NavigationOutcome<R>> => new Navigator(page, url, options).run();
