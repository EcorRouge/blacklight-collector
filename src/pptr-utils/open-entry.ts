import { getDomain } from 'tldts';
import { NavigablePage, navigateWithinBudget, NavigationOptions, NavigationResponse } from './navigate';

export type EntryAttemptOutcome = 'success' | 'http_status' | 'error' | 'deadline';

/** One browser navigation towards the entry page; JSON-serialisable for the scan result. */
export interface EntryAttempt {
    url: string;
    outcome: EntryAttemptOutcome;
    status?: number;
    error?: string;
}

export interface EntryResult<R> {
    /** The response of the candidate that loaded, or null when none did. */
    response: R | null;
    attempts: EntryAttempt[];
    deadlineReached: boolean;
}

/** Chromium's error for a host that does not resolve; every candidate on that host would fail the same way. */
const UNRESOLVABLE_HOST = 'ERR_NAME_NOT_RESOLVED';

/**
 * Tries each entry candidate in order until one loads. Fallback candidates get a single attempt:
 * the first candidate already spent the retry budget on transient failures, and a dead site
 * should not burn the whole scan deadline trying every variant several times.
 */
export const openEntryPage = async <R extends NavigationResponse>(
    page: NavigablePage<R>,
    candidates: readonly string[],
    options: NavigationOptions
): Promise<EntryResult<R>> => {
    const attempts: EntryAttempt[] = [];
    const unresolvableHosts = new Set<string>();
    for (const [index, url] of candidates.entries()) {
        if (options.deadline.isExpired()) {
            return { response: null, attempts, deadlineReached: true };
        }
        const host = new URL(url).hostname;
        if (unresolvableHosts.has(host)) {
            continue;
        }
        const outcome = await navigateWithinBudget(page, url, index === 0 ? options : { ...options, maxRetries: 1 });
        switch (outcome.kind) {
            case 'success':
                attempts.push({ url, outcome: 'success', status: outcome.response.status() });
                return { response: outcome.response, attempts, deadlineReached: false };
            case 'http_error':
                attempts.push({ url, outcome: 'http_status', status: outcome.response.status() });
                break;
            case 'network_error':
                attempts.push({ url, outcome: 'error', error: outcome.error.message });
                if (outcome.error.message.includes(UNRESOLVABLE_HOST)) {
                    unresolvableHosts.add(host);
                }
                break;
            case 'deadline':
                attempts.push(outcome.response ? { url, outcome: 'deadline', status: outcome.response.status() } : { url, outcome: 'deadline' });
                return { response: null, attempts, deadlineReached: true };
            default: {
                const unreachable: never = outcome;
                throw new Error(`Unhandled navigation outcome ${JSON.stringify(unreachable)}`);
            }
        }
    }
    return { response: null, attempts, deadlineReached: options.deadline.isExpired() };
};

/** Status of the most recent attempt that got an HTTP answer, for the legacy failure message. */
export const lastHttpStatus = (attempts: readonly EntryAttempt[]): number | undefined =>
    [...attempts].reverse().find(attempt => attempt.status !== undefined)?.status;

/** Where the crawl started versus where it was asked to start. */
export const entryMetadata = (requestedUrl: string, finalUrl: string) => ({
    original_domain: getDomain(requestedUrl),
    final_domain: getDomain(finalUrl),
    entry_redirected: new URL(requestedUrl).hostname !== new URL(finalUrl).hostname
});
