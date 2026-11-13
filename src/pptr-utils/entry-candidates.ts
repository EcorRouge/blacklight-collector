import { parse } from 'tldts';

/** Why the pre-resolution request chain stopped without reaching a page. */
export type ResolutionFailureKind = 'tls' | 'connection' | 'dns' | 'timeout' | 'other';

/** The parts of an entry resolution that decide which URLs the browser should try. */
export interface ResolvedEntry {
    finalUrl: string;
    failure: { kind: ResolutionFailureKind; message: string } | null;
}

/**
 * The other host of an apex/www pair, or null when swapping is not meaningful.
 *
 * Only `example.com` <-> `www.example.com` is swapped. Deeper subdomains such as
 * `api.example.com` are distinct sites, so neither a `www.` prefix nor the parent
 * domain is a sensible stand-in for them.
 */
export const swapWwwHost = (hostname: string): string | null => {
    const parsed = parse(hostname);
    if (parsed.isIp || !parsed.domain) {
        return null;
    }
    if (parsed.hostname === parsed.domain) {
        return `www.${parsed.domain}`;
    }
    if (parsed.hostname === `www.${parsed.domain}`) {
        return parsed.domain;
    }
    return null;
};

const withHost = (url: URL, hostname: string): string => {
    const copy = new URL(url.href);
    copy.hostname = hostname;
    return copy.href;
};

const withScheme = (url: URL, protocol: 'http:'): string => {
    const copy = new URL(url.href);
    copy.protocol = protocol;
    return copy.href;
};

const hasNonRootPath = (url: URL): boolean => url.pathname !== '/' || url.search !== '';

/**
 * Ordered, de-duplicated list of URLs to try as the crawl entry point:
 * the resolved final URL, the requested URL, the apex/www twin of the final host,
 * plain http when https could not even connect, and finally the origin roots of
 * any candidate that pointed at a deeper path.
 */
export const buildEntryCandidates = (requestedUrl: string, resolution: ResolvedEntry): string[] => {
    const final = new URL(resolution.finalUrl);
    const ordered: string[] = [final.href, new URL(requestedUrl).href];

    const swappedHost = swapWwwHost(final.hostname);
    if (swappedHost) {
        ordered.push(withHost(final, swappedHost));
    }

    // Plain http only helps when the TLS layer or the https port itself is the problem.
    const httpsUnreachable = resolution.failure !== null && (resolution.failure.kind === 'tls' || resolution.failure.kind === 'connection');
    if (final.protocol === 'https:' && httpsUnreachable) {
        ordered.push(withScheme(final, 'http:'));
    }

    const roots = ordered
        .map(candidate => new URL(candidate))
        .filter(hasNonRootPath)
        .map(candidate => `${candidate.origin}/`);

    return Array.from(new Set([...ordered, ...roots]));
};
