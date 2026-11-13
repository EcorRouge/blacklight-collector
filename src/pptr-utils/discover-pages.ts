import { TextFetcher } from './bounded-fetch';
import { COMMON_PATHS, ErrorPage, findErrorPageLinks, findSitemapPages } from './discover-sources';
import { NavigablePage, navigateWithinBudget, NavigationOptions, NavigationResponse } from './navigate';
import { attemptFromOutcome, EntryAttempt, EntryAttemptSource } from './open-entry';

export type { ErrorPage } from './discover-sources';

/**
 * Fallback discovery for a site whose entry page answers with an HTTP error (403 bot walls on
 * the root only, 404 on API-style subdomains with an empty root). Other pages of the same site
 * often still load, and one of them is enough to inspect what the site runs.
 */

export type DiscoverySource = Exclude<EntryAttemptSource, 'candidate'>;

export interface DiscoveryInput<R extends NavigationResponse> {
    page: NavigablePage<R>;
    navigation: NavigationOptions;
    fetchText: TextFetcher;
    /** Error responses of the entry candidates, newest first. */
    errorPages: readonly ErrorPage[];
    /** Registrable domains (bare hosts for IPs) that discovered pages may belong to. */
    allowedDomains: readonly string[];
    /** Origin for the sitemap and common-path lookups. */
    origin: string;
    /** URLs the entry already tried; they are not navigated again. */
    attempted: readonly string[];
    /** Hard cap on discovery navigations, so a dead site cannot burn the whole scan budget. */
    maxNavigations?: number;
    log?: (message: string) => void;
}

export interface DiscoveryResult<R> {
    response: R | null;
    /** URL that loaded, or null. */
    url: string | null;
    attempts: EntryAttempt[];
    deadlineReached: boolean;
}

export const MAX_DISCOVERY_NAVIGATIONS = 8;

/** Per-source share of the navigation cap, so a page full of dead links cannot crowd out the other sources. */
const SOURCE_NAVIGATION_LIMIT: Record<DiscoverySource, number> = {
    error_page_link: 3,
    sitemap: 3,
    common_path: COMMON_PATHS.length
};

const normalise = (url: string): string => new URL(url).href;

/**
 * Tries same-site pages from the error pages' links, then the sitemaps, then common paths, one
 * navigation each, until one loads (2xx/304). Sources are only queried when the earlier ones
 * did not produce a page, so a site whose error page links work costs no extra requests.
 */
export const discoverFallbackPage = async <R extends NavigationResponse>(input: DiscoveryInput<R>): Promise<DiscoveryResult<R>> => {
    const { page, navigation, fetchText, allowedDomains, origin } = input;
    const log = input.log ?? console.log;
    const maxNavigations = input.maxNavigations ?? MAX_DISCOVERY_NAVIGATIONS;
    const sources: { source: DiscoverySource; urls: () => Promise<string[]> }[] = [
        { source: 'error_page_link', urls: () => findErrorPageLinks(input.errorPages, fetchText, allowedDomains, log) },
        { source: 'sitemap', urls: () => findSitemapPages(fetchText, origin, allowedDomains) },
        { source: 'common_path', urls: async () => COMMON_PATHS.map(path => `${origin}${path}`) }
    ];
    const tried = new Set(input.attempted.map(normalise));
    const attempts: EntryAttempt[] = [];
    const notFound = (deadlineReached: boolean): DiscoveryResult<R> => ({ response: null, url: null, attempts, deadlineReached });

    for (const { source, urls } of sources) {
        if (attempts.length >= maxNavigations || navigation.deadline.isExpired()) {
            break;
        }
        const fresh = (await urls()).map(normalise).filter(url => !tried.has(url));
        log(`Page discovery: ${fresh.length} ${source} candidates`);
        for (const url of fresh.slice(0, SOURCE_NAVIGATION_LIMIT[source])) {
            if (attempts.length >= maxNavigations) {
                break;
            }
            if (navigation.deadline.isExpired()) {
                return notFound(true);
            }
            tried.add(url);
            const outcome = await navigateWithinBudget(page, url, { ...navigation, maxRetries: 1 });
            attempts.push({ ...attemptFromOutcome(url, outcome), source });
            if (outcome.kind === 'success') {
                return { response: outcome.response, url, attempts, deadlineReached: false };
            }
            if (outcome.kind === 'deadline') {
                return notFound(true);
            }
        }
    }
    return notFound(navigation.deadline.isExpired());
};
