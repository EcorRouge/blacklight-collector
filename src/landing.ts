import { HTTPResponse, Page } from 'puppeteer';
import { CollectorConfig } from './collector-config';
import { CrawlProgress, DEADLINE_ERROR } from './crawl-progress';
import { createTextFetcher } from './pptr-utils/bounded-fetch';
import { discoverFallbackPage } from './pptr-utils/discover-pages';
import { siteKey } from './pptr-utils/discover-sources';
import { NavigationOptions } from './pptr-utils/navigate';
import { EntryAttempt, lastHttpStatus, openEntryPage } from './pptr-utils/open-entry';
import { resolveEntryUrl } from './pptr-utils/resolve-entry-url';

export interface LandingInput {
    page: Page;
    inUrl: string;
    config: CollectorConfig;
    navigation: NavigationOptions;
    progress: CrawlProgress;
}

export interface Landing {
    /** Response of the page the crawl starts from, or null when no page loaded. */
    response: HTTPResponse | null;
    /** Every navigation made to find that page, entry candidates first. */
    attempts: EntryAttempt[];
    /** Legacy wording for a scan that ends without any page. */
    failureMessage: string;
}

/**
 * Finds the page the crawl starts from: the entry candidates first and, when every one of them
 * answered with an HTTP error, other pages of the same site. Sites that do not resolve or that
 * ran out of time are not probed further; there is nothing left to discover or no time to do it.
 */
export const reachLandingPage = async ({ page, inUrl, config, navigation, progress }: LandingInput): Promise<Landing> => {
    const { deadline } = navigation;
    const entry = deadline.isExpired()
        ? { candidates: [inUrl], finalUrl: inUrl }
        : await resolveEntryUrl(inUrl, { deadline, userAgent: config.emulateDevice?.userAgent, extraChromiumArgs: config.extraChromiumArgs });
    console.log('Going to the first url', inUrl, 'candidates:', entry.candidates);
    const first = await openEntryPage(page, entry.candidates, navigation);
    const candidateAttempts = first.attempts.map(attempt => ({ ...attempt, source: 'candidate' as const }));
    const statusMessage = `Initial page returned non-2xx status: ${lastHttpStatus(first.attempts)}`;

    if (first.response !== null) {
        return { response: first.response, attempts: candidateAttempts, failureMessage: statusMessage };
    }
    const answered = first.attempts.find(attempt => attempt.outcome === 'http_status');
    if (first.deadlineReached || deadline.isExpired() || answered === undefined) {
        progress.failedAttempts(candidateAttempts);
        return { response: null, attempts: candidateAttempts, failureMessage: first.deadlineReached || deadline.isExpired() ? DEADLINE_ERROR : statusMessage };
    }

    console.log(`No entry candidate of ${inUrl} loaded; looking for other pages of the site`);
    progress.markIncomplete();
    const discovered = await discoverFallbackPage({
        page,
        navigation,
        fetchText: createTextFetcher({ deadline, userAgent: config.emulateDevice?.userAgent, extraChromiumArgs: config.extraChromiumArgs }),
        // Newest first: the browser is most likely to still hold the body of the last error page.
        errorPages: [...first.httpErrors].reverse().map(({ url, response }) => ({ url, body: () => response.text() })),
        allowedDomains: Array.from(new Set([siteKey(inUrl), siteKey(entry.finalUrl)].filter((key): key is string => key !== null))),
        origin: new URL(answered.url).origin,
        attempted: first.attempts.map(attempt => attempt.url)
    });
    const attempts = [...candidateAttempts, ...discovered.attempts];
    progress.failedAttempts(attempts);
    return {
        response: discovered.response,
        attempts,
        failureMessage: discovered.deadlineReached ? DEADLINE_ERROR : statusMessage
    };
};
