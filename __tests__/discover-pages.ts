import { createTextFetcher, FetchedText, MAX_DISCOVERY_BYTES, TextFetcher } from '../src/pptr-utils/bounded-fetch';
import { discoverFallbackPage, DiscoveryInput } from '../src/pptr-utils/discover-pages';
import { extractPageLinks, findSitemapPages, parseRobotsSitemaps, parseSitemap, SITEMAP_URL_LIMIT } from '../src/pptr-utils/discover-sources';
import { FetchInit } from '../src/pptr-utils/entry-http';
import { NavigablePage, NavigationOptions, NavigationResponse } from '../src/pptr-utils/navigate';
import { ScanDeadline } from '../src/pptr-utils/scan-deadline';
import { noopSession } from './shared/navigation-fakes';

const silent = () => undefined;

/** A site where every URL answers with the status in the map, 404 otherwise. */
const sitePage = (statuses: Record<string, number>) => {
    const visited: string[] = [];
    const page: NavigablePage<NavigationResponse> = {
        goto: async url => {
            visited.push(url);
            const status = statuses[url] ?? 404;
            return { status: () => status };
        },
        createCDPSession: async () => noopSession
    };
    return { page, visited };
};

/** A fetcher serving fixed bodies; anything else is a 404. */
const fakeFetcher = (bodies: Record<string, string>) => {
    const requested: string[] = [];
    const fetchText: TextFetcher = async url => {
        requested.push(url);
        return url in bodies ? { url, status: 200, text: bodies[url] } : { url, status: 404, text: '' };
    };
    return { fetchText, requested };
};

const navigation = (deadline = new ScanDeadline(60000)): NavigationOptions => ({
    waitUntil: 'networkidle2',
    navigationTimeoutMs: 1000,
    defaultTimeout: 1000,
    maxRetries: 3,
    deadline,
    retryBackoffMs: 1,
    log: silent
});

const urlset = (urls: string[]) => `<?xml version="1.0"?><urlset>${urls.map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const sitemapIndex = (urls: string[]) => `<?xml version="1.0"?><sitemapindex>${urls.map(u => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;

describe('extractPageLinks', () => {
    it('resolves relative links, drops fragments and keeps only http(s) pages', () => {
        const html = `<a href="/login#form">a</a><A HREF='https://other.example/x'>b</A><a class="x" href=about.html>c</a>
            <a href="mailto:x@y.z">m</a><a href="/doc.pdf">p</a><a href="/q?a=1&amp;b=2">q</a><a name="top">n</a>`;

        expect(extractPageLinks(html, 'https://site.example/dir/page')).toEqual([
            'https://site.example/login',
            'https://other.example/x',
            'https://site.example/dir/about.html',
            'https://site.example/q?a=1&b=2'
        ]);
    });
});

describe('parseRobotsSitemaps', () => {
    it('reads every Sitemap line regardless of case and resolves relative entries', () => {
        const robots = 'User-agent: *\nDisallow: /admin\nSitemap: https://site.example/sitemap_index.xml\r\nsitemap:/news.xml\n# Sitemap: https://ignored.example/';

        expect(parseRobotsSitemaps(robots, 'https://site.example/robots.txt')).toEqual([
            'https://site.example/sitemap_index.xml',
            'https://site.example/news.xml'
        ]);
    });
});

describe('parseSitemap', () => {
    it('reads url locations including CDATA and escaped entities', () => {
        const xml = '<urlset><url><loc> https://a.example/1 </loc></url><url><loc><![CDATA[https://a.example/2?x=1]]></loc></url><url><loc>https://a.example/3?a=1&amp;b=2</loc></url></urlset>';

        expect(parseSitemap(xml)).toEqual({ isIndex: false, locations: ['https://a.example/1', 'https://a.example/2?x=1', 'https://a.example/3?a=1&b=2'] });
    });

    it('recognises a sitemap index and keeps the entries of a body cut off by the size cap', () => {
        const xml = '<sitemapindex><sitemap><loc>https://a.example/s1.xml</loc></sitemap><sitemap><loc>https://a.example/s2';

        expect(parseSitemap(xml)).toEqual({ isIndex: true, locations: ['https://a.example/s1.xml'] });
    });
});

describe('findSitemapPages', () => {
    const origin = 'https://site.example';

    it('follows robots.txt to a sitemap index, one level deep, keeping only same-site pages', async () => {
        const { fetchText, requested } = fakeFetcher({
            [`${origin}/robots.txt`]: `Sitemap: ${origin}/index.xml`,
            [`${origin}/index.xml`]: sitemapIndex([`${origin}/pages.xml`, `${origin}/nested-index.xml`]),
            [`${origin}/pages.xml`]: urlset([`${origin}/a`, 'https://cdn.other.example/b', `https://www.site.example/c`]),
            [`${origin}/nested-index.xml`]: sitemapIndex([`${origin}/too-deep.xml`]),
            [`${origin}/too-deep.xml`]: urlset([`${origin}/deep`])
        });

        const pages = await findSitemapPages(fetchText, origin, ['site.example']);

        expect(pages).toEqual([`${origin}/a`, 'https://www.site.example/c']);
        expect(requested).not.toContain(`${origin}/too-deep.xml`);
    });

    it('falls back to /sitemap.xml and returns at most the first 20 pages', async () => {
        const many = Array.from({ length: 30 }, (_, i) => `${origin}/p${i}`);
        const { fetchText } = fakeFetcher({ [`${origin}/sitemap.xml`]: urlset(many) });

        expect(await findSitemapPages(fetchText, origin, ['site.example'])).toEqual(many.slice(0, SITEMAP_URL_LIMIT));
    });
});

describe('createTextFetcher', () => {
    const streamOf = (bytes: number) =>
        new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(64 * 1024).fill(97));
                bytes -= 64 * 1024;
                if (bytes <= 0) {
                    controller.close();
                }
            }
        });

    it('stops reading a body at 512 KB and follows redirects', async () => {
        const inits: FetchInit[] = [];
        const fetchText = createTextFetcher({
            deadline: new ScanDeadline(60000),
            log: silent,
            fetchImpl: async (_url, init) => {
                inits.push(init);
                return { status: 200, url: 'https://site.example/final.xml', headers: { get: () => null }, body: streamOf(4 * 1024 * 1024) };
            }
        });

        const fetched = (await fetchText('https://site.example/sitemap.xml')) as FetchedText;

        expect(fetched.url).toBe('https://site.example/final.xml');
        expect(fetched.text.length).toBe(MAX_DISCOVERY_BYTES);
        expect(inits[0].redirect).toBe('follow');
    });

    it('returns null without a request once the scan deadline has passed', async () => {
        const fetchImpl = jest.fn();
        const fetchText = createTextFetcher({ deadline: new ScanDeadline(0), log: silent, fetchImpl });

        expect(await fetchText('https://site.example/robots.txt')).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns null when the request fails and never logs the proxy credentials', async () => {
        const logs: string[] = [];
        const fetchText = createTextFetcher({
            deadline: new ScanDeadline(60000),
            extraChromiumArgs: ['--proxy-server=http://user:s3cret@proxy.example:8080'],
            createProxyDispatcher: () => ({}),
            log: message => logs.push(message),
            fetchImpl: async () => {
                throw new Error('connect via user:s3cret@proxy.example:8080 refused');
            }
        });

        expect(await fetchText('https://site.example/robots.txt')).toBeNull();
        expect(logs.join('\n')).not.toContain('s3cret');
    });
});

describe('discoverFallbackPage', () => {
    const origin = 'https://site.example';
    const input = (overrides: Partial<DiscoveryInput<NavigationResponse>>): DiscoveryInput<NavigationResponse> => ({
        page: sitePage({}).page,
        navigation: navigation(),
        fetchText: fakeFetcher({}).fetchText,
        errorPages: [],
        allowedDomains: ['site.example'],
        origin,
        attempted: [`${origin}/`],
        log: silent,
        ...overrides
    });

    it('uses same-site links of the error page before any other source', async () => {
        const { page, visited } = sitePage({ [`${origin}/welcome`]: 200 });
        const { fetchText, requested } = fakeFetcher({});
        const errorPages = [{ url: `${origin}/`, body: async () => '<a href="https://evil.example/">x</a><a href="/">home</a><a href="/welcome">in</a>' }];

        const result = await discoverFallbackPage(input({ page, fetchText, errorPages }));

        expect(result.url).toBe(`${origin}/welcome`);
        expect(result.attempts).toEqual([{ url: `${origin}/welcome`, outcome: 'success', status: 200, source: 'error_page_link' }]);
        expect(visited).toEqual([`${origin}/welcome`]);
        expect(requested).toEqual([]);
    });

    it('fetches the error page itself when the browser no longer holds its body', async () => {
        const { page } = sitePage({ [`${origin}/start`]: 200 });
        const { fetchText, requested } = fakeFetcher({ [`${origin}/`]: '<a href="/start">start</a>' });
        const errorPages = [{ url: `${origin}/`, body: async (): Promise<string> => { throw new Error('No resource with given identifier found'); } }];

        const result = await discoverFallbackPage(input({ page, fetchText, errorPages }));

        expect(requested[0]).toBe(`${origin}/`);
        expect(result.attempts.map(a => [a.url, a.source])).toEqual([[`${origin}/start`, 'error_page_link']]);
    });

    it('moves on to sitemap pages and then common paths, recording the source of each attempt', async () => {
        const { page } = sitePage({ [`${origin}/login`]: 200 });
        const { fetchText } = fakeFetcher({ [`${origin}/sitemap.xml`]: urlset([`${origin}/gone`]) });

        const result = await discoverFallbackPage(input({ page, fetchText }));

        expect(result.attempts).toEqual([
            { url: `${origin}/gone`, outcome: 'http_status', status: 404, source: 'sitemap' },
            { url: `${origin}/login`, outcome: 'success', status: 200, source: 'common_path' }
        ]);
    });

    it('gives up after the navigation cap on a site where nothing loads', async () => {
        const { page, visited } = sitePage({});
        const links = Array.from({ length: 10 }, (_, i) => `<a href="/l${i}">l</a>`).join('');
        const { fetchText } = fakeFetcher({ [`${origin}/sitemap.xml`]: urlset(Array.from({ length: 10 }, (_, i) => `${origin}/s${i}`)) });

        const result = await discoverFallbackPage(input({ page, fetchText, errorPages: [{ url: `${origin}/`, body: async () => links }] }));

        expect(result.response).toBeNull();
        expect(visited).toHaveLength(8);
        expect(result.attempts.map(a => a.source)).toEqual([
            'error_page_link', 'error_page_link', 'error_page_link', 'sitemap', 'sitemap', 'sitemap', 'common_path', 'common_path'
        ]);
    });

    it('never retries the URLs the entry already tried', async () => {
        const { page, visited } = sitePage({});

        await discoverFallbackPage(input({ page, attempted: [`${origin}/`, `${origin}/login`] }));

        expect(visited).not.toContain(`${origin}/login`);
        expect(visited[0]).toBe(`${origin}/signin`);
    });

    it('stops without navigating once the scan deadline has passed', async () => {
        const { page, visited } = sitePage({ [`${origin}/login`]: 200 });

        const result = await discoverFallbackPage(input({ page, navigation: navigation(new ScanDeadline(0)) }));

        expect(result).toMatchObject({ response: null, deadlineReached: true, attempts: [] });
        expect(visited).toEqual([]);
    });
});
