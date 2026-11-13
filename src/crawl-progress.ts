import { scrubText } from './helpers/scrub-secrets';
import { EntryAttempt } from './pptr-utils/open-entry';

export const DEADLINE_ERROR = 'Scan time budget exhausted';

/** A page the crawl tried and could not load. */
export interface FailedPage {
    url: string;
    status?: number;
    error?: string;
}

/**
 * Which pages loaded and which did not. A scan that lost pages is still worth reporting,
 * but consumers need to know the picture is incomplete and where the gaps are.
 */
export class CrawlProgress {
    readonly pagesSucceeded: string[] = [];
    readonly pagesFailed: FailedPage[] = [];
    private incomplete = false;

    succeeded(url: string): void {
        if (!this.pagesSucceeded.includes(url)) {
            this.pagesSucceeded.push(url);
        }
    }

    /** A failed page always leaves the crawl smaller than requested. */
    failed(page: FailedPage): void {
        this.pagesFailed.push(page.error === undefined ? page : { ...page, error: scrubText(page.error) });
        this.incomplete = true;
    }

    failedAttempts(attempts: readonly EntryAttempt[]): void {
        attempts.filter(attempt => attempt.outcome !== 'success').forEach(attempt => this.failed(failedPageOf(attempt)));
    }

    /** Marks the crawl incomplete for a reason other than a failed page (fallback discovery, deadline). */
    markIncomplete(): void {
        this.incomplete = true;
    }

    get partial(): boolean {
        return this.incomplete;
    }

    summary() {
        return { partial: this.incomplete, pages_succeeded: [...this.pagesSucceeded], pages_failed: [...this.pagesFailed] };
    }
}

const failedPageOf = (attempt: EntryAttempt): FailedPage => {
    const page: FailedPage = { url: attempt.url };
    if (attempt.status !== undefined) {
        page.status = attempt.status;
    }
    if (attempt.error !== undefined) {
        page.error = attempt.error;
    } else if (attempt.outcome === 'deadline') {
        page.error = DEADLINE_ERROR;
    }
    return page;
};
