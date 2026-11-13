/**
 * Wall-clock budget for a whole crawl.
 *
 * Individual navigation timeouts alone do not bound a scan: a site with many slow
 * pages can still keep the browser busy far longer than the caller is willing to
 * wait. Every navigation and retry consults one shared deadline so the crawl as a
 * whole finishes in predictable time.
 */
export class ScanDeadline {
    private readonly expiresAt: number;

    constructor(budgetMs: number, private readonly now: () => number = Date.now) {
        this.expiresAt = now() + budgetMs;
    }

    remainingMs(): number {
        return Math.max(0, this.expiresAt - this.now());
    }

    isExpired(): boolean {
        return this.remainingMs() <= 0;
    }
}
