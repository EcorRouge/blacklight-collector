import { getDomain } from 'tldts';
import { TextFetcher } from './bounded-fetch';

/** Where fallback pages come from when none of the entry candidates loaded. */

/** Pages that exist on most sites even when the root path is empty or blocked. */
export const COMMON_PATHS: readonly string[] = ['/login', '/signin', '/home', '/index.html', '/about', '/contact'];

/** How many page URLs one sitemap search may yield. */
export const SITEMAP_URL_LIMIT = 20;

/** Sitemaps fetched per level, so a long robots.txt or index cannot fan out into many requests. */
const SITEMAPS_PER_LEVEL = 3;

/** Registrable domain, or the bare host for IPs and single-label hosts that have none. */
export const siteKey = (url: string): string | null => {
    try {
        return getDomain(url) ?? new URL(url).hostname;
    } catch (error) {
        return null;
    }
};

const toPageUrl = (href: string, base: string): string | null => {
    let url: URL;
    try {
        url = new URL(href, base);
    } catch (error) {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    url.hash = '';
    return /\.(pdf|zip)$/i.test(url.pathname) ? null : url.href;
};

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeEntities = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, entity => XML_ENTITIES[entity]);

const unique = (urls: (string | null)[]): string[] => Array.from(new Set(urls.filter((url): url is string => url !== null)));

/** Absolute http(s) targets of the `<a href>` elements in an HTML document, in document order. */
export const extractPageLinks = (html: string, baseUrl: string): string[] => {
    const anchor = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    const links: (string | null)[] = [];
    for (let match = anchor.exec(html); match !== null; match = anchor.exec(html)) {
        const href = decodeEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
        links.push(href === '' ? null : toPageUrl(href, baseUrl));
    }
    return unique(links);
};

/** `Sitemap:` entries of a robots.txt, resolved against the robots.txt URL. */
export const parseRobotsSitemaps = (robotsTxt: string, robotsUrl: string): string[] =>
    unique(
        robotsTxt
            .split(/\r?\n/)
            .map(line => /^\s*sitemap\s*:\s*(\S+)/i.exec(line))
            .map(match => (match ? toPageUrl(match[1], robotsUrl) : null))
    );

export interface ParsedSitemap {
    isIndex: boolean;
    locations: string[];
}

/** `<loc>` entries of a sitemap or sitemap index. Tolerates a body cut off by the size cap. */
export const parseSitemap = (xml: string): ParsedSitemap => {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
    const locations: string[] = [];
    for (let match = loc.exec(xml); match !== null; match = loc.exec(xml)) {
        locations.push(decodeEntities(match[1]));
    }
    return { isIndex: /<sitemapindex[\s>]/i.test(xml), locations };
};

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Page URLs from the site's sitemaps: those named in robots.txt plus `/sitemap.xml`, following
 * at most one level of sitemap index. Only pages of the allowed domains are returned.
 */
export const findSitemapPages = async (fetchText: TextFetcher, origin: string, allowedDomains: readonly string[]): Promise<string[]> => {
    const isAllowed = (url: string) => allowedDomains.includes(siteKey(url) ?? '');
    const robotsUrl = `${origin}/robots.txt`;
    const robots = await fetchText(robotsUrl);
    const declared = robots && isSuccess(robots.status) ? parseRobotsSitemaps(robots.text, robots.url) : [];
    const sitemaps = unique([...declared, `${origin}/sitemap.xml`]).slice(0, SITEMAPS_PER_LEVEL);

    const pages: string[] = [];
    const collect = async (sitemapUrls: string[], followIndex: boolean): Promise<void> => {
        for (const sitemapUrl of sitemapUrls) {
            if (pages.length >= SITEMAP_URL_LIMIT) {
                return;
            }
            const fetched = await fetchText(sitemapUrl);
            if (!fetched || !isSuccess(fetched.status)) {
                continue;
            }
            const sitemap = parseSitemap(fetched.text);
            if (sitemap.isIndex) {
                if (followIndex) {
                    await collect(unique(sitemap.locations.map(l => toPageUrl(l, fetched.url))).slice(0, SITEMAPS_PER_LEVEL), false);
                }
                continue;
            }
            for (const location of sitemap.locations) {
                const page = toPageUrl(location, fetched.url);
                if (page !== null && isAllowed(page) && !pages.includes(page) && pages.length < SITEMAP_URL_LIMIT) {
                    pages.push(page);
                }
            }
        }
    };
    await collect(sitemaps, true);
    return pages;
};

/** Error-page body source: the browser's copy first, a fresh request when the browser no longer has it. */
export interface ErrorPage {
    url: string;
    body: () => Promise<string>;
}

const ERROR_PAGES_TO_READ = 2;

/** Same-site links found in the bodies of the error pages the entry candidates returned. */
export const findErrorPageLinks = async (
    errorPages: readonly ErrorPage[],
    fetchText: TextFetcher,
    allowedDomains: readonly string[],
    log: (message: string) => void
): Promise<string[]> => {
    const links: string[] = [];
    for (const errorPage of errorPages.slice(0, ERROR_PAGES_TO_READ)) {
        let html: string | null = null;
        let base = errorPage.url;
        try {
            html = await errorPage.body();
        } catch (error) {
            log(`Body of error page ${errorPage.url} no longer available in the browser (${error.message}); fetching it`);
            const fetched = await fetchText(errorPage.url);
            html = fetched ? fetched.text : null;
            base = fetched ? fetched.url : base;
        }
        if (html) {
            links.push(...extractPageLinks(html, base).filter(link => allowedDomains.includes(siteKey(link) ?? '')));
        }
    }
    return unique(links);
};
