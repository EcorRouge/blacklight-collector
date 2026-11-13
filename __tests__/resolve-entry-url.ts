import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { buildEntryCandidates, swapWwwHost } from '../src/pptr-utils/entry-candidates';
import { findDocumentRedirect } from '../src/pptr-utils/document-redirect';
import { NavigablePage, NavigationOptions, NavigationResponse } from '../src/pptr-utils/navigate';
import { lastHttpStatus, openEntryPage } from '../src/pptr-utils/open-entry';
import { parseProxyArg } from '../src/pptr-utils/proxy-dispatcher';
import { FALLBACK_USER_AGENT, FetchInit, FetchLike, resolveEntryUrl, ResolveEntryOptions, ResponseLike } from '../src/pptr-utils/resolve-entry-url';
import { ScanDeadline } from '../src/pptr-utils/scan-deadline';

jest.setTimeout(30000);

type Method = FetchInit['method'];
type Route = (method: Method) => ResponseLike | Error;
interface FetchCall {
    url: string;
    init: FetchInit;
}

const fetchError = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

const page = (body: string, status = 200): Route => method =>
    new Response(method === 'HEAD' ? null : body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, status = 301): Route => () => new Response(null, { status, headers: { location } });
const fails = (code: string): Route => () => fetchError(code);

const fakeFetch = (routes: Record<string, Route>, calls: FetchCall[] = []): FetchLike => async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    const result = route ? route(init.method) : fetchError('ENOTFOUND');
    if (result instanceof Error) {
        throw result;
    }
    return result;
};

const resolveWith = (url: string, routes: Record<string, Route>, overrides: Partial<ResolveEntryOptions> = {}) =>
    resolveEntryUrl(url, { deadline: new ScanDeadline(60000), fetchImpl: fakeFetch(routes), log: () => undefined, ...overrides });

describe('resolveEntryUrl with an injected fetch', () => {
    it('follows an apex to www redirect and keeps the apex as the next candidate', async () => {
        const result = await resolveWith('https://wildfireav.com/', {
            'https://wildfireav.com/': redirect('https://www.wildfireav.com/'),
            'https://www.wildfireav.com/': page('<html>home</html>')
        });

        expect(result.finalUrl).toBe('https://www.wildfireav.com/');
        expect(result.hops).toEqual(['https://wildfireav.com/', 'https://www.wildfireav.com/']);
        expect(result.candidates).toEqual(['https://www.wildfireav.com/', 'https://wildfireav.com/']);
    });

    it('offers the www host when the apex does not resolve at all', async () => {
        const result = await resolveWith('https://findagrave.com/', { 'https://findagrave.com/': fails('ENOTFOUND') });

        expect(result.failure?.kind).toBe('dns');
        expect(result.candidates).toEqual(['https://findagrave.com/', 'https://www.findagrave.com/']);
    });

    it('follows a redirect to a different company domain', async () => {
        const result = await resolveWith('https://accupointsurveyingdesign.com/', {
            'https://accupointsurveyingdesign.com/': redirect('https://accupointsurveying.com/'),
            'https://accupointsurveying.com/': page('<html>ok</html>')
        });

        expect(result.finalUrl).toBe('https://accupointsurveying.com/');
        expect(result.candidates).toEqual([
            'https://accupointsurveying.com/',
            'https://accupointsurveyingdesign.com/',
            'https://www.accupointsurveying.com/'
        ]);
    });

    it('keeps the 404 apex first but lists the www host as fallback', async () => {
        const result = await resolveWith('https://sunmerger.com/', { 'https://sunmerger.com/': page('missing', 404) });

        expect(result.status).toBe(404);
        expect(result.candidates).toEqual(['https://sunmerger.com/', 'https://www.sunmerger.com/']);
    });

    it('adds an http candidate when https refuses connections', async () => {
        const result = await resolveWith('https://j2studio.us/', { 'https://j2studio.us/': fails('ECONNREFUSED') });

        expect(result.failure?.kind).toBe('connection');
        expect(result.candidates).toContain('http://j2studio.us/');
    });

    it('does not add an http candidate for DNS failures', async () => {
        const result = await resolveWith('https://gone.example.com/', {});

        expect(result.candidates.some(c => c.startsWith('http:'))).toBe(false);
    });

    it('follows one meta refresh hop and no more', async () => {
        const result = await resolveWith('https://plswv.com/', {
            'https://plswv.com/': page('<meta http-equiv="refresh" content="0; url=/home">'),
            'https://plswv.com/home': page('<meta http-equiv="refresh" content="0; url=/again">')
        });

        expect(result.finalUrl).toBe('https://plswv.com/home');
    });

    it('falls back to GET when HEAD is rejected with 405', async () => {
        const calls: FetchCall[] = [];
        const routes: Record<string, Route> = {
            'https://eku.edu/': method => (method === 'HEAD' ? new Response(null, { status: 405 }) : new Response(null, { status: 302, headers: { location: 'https://www.eku.edu/' } })),
            'https://www.eku.edu/': page('<html>eku</html>')
        };
        const result = await resolveEntryUrl('https://eku.edu/', { deadline: new ScanDeadline(60000), fetchImpl: fakeFetch(routes, calls), log: () => undefined });

        expect(result.finalUrl).toBe('https://www.eku.edu/');
        expect(calls.slice(0, 2).map(c => c.init.method)).toEqual(['HEAD', 'GET']);
    });

    it('retries with GET when HEAD errors, but not when the host does not resolve', async () => {
        const calls: FetchCall[] = [];
        const routes: Record<string, Route> = {
            'https://regentparksc.com/': method => (method === 'HEAD' ? fetchError('ECONNRESET') : new Response('<html>ok</html>', { status: 200 }))
        };
        const ok = await resolveEntryUrl('https://regentparksc.com/', { deadline: new ScanDeadline(60000), fetchImpl: fakeFetch(routes, calls), log: () => undefined });
        await resolveEntryUrl('https://nxdomain.example/', { deadline: new ScanDeadline(60000), fetchImpl: fakeFetch({}, calls), log: () => undefined });

        expect(ok.status).toBe(200);
        expect(calls.map(c => `${c.init.method} ${c.url}`)).toEqual(['HEAD https://regentparksc.com/', 'GET https://regentparksc.com/', 'HEAD https://nxdomain.example/']);
    });

    it('sends the given user agent and falls back to a Chrome one', async () => {
        const calls: FetchCall[] = [];
        const routes = { 'https://ua.example.com/': page('x') };
        const options = { deadline: new ScanDeadline(60000), fetchImpl: fakeFetch(routes, calls), log: () => undefined };
        await resolveEntryUrl('https://ua.example.com/', { ...options, userAgent: 'Custom/1.0' });
        await resolveEntryUrl('https://ua.example.com/', options);

        expect(calls[0].init.headers['user-agent']).toBe('Custom/1.0');
        expect(calls[calls.length - 1].init.headers['user-agent']).toBe(FALLBACK_USER_AGENT);
    });

    it('makes no request once the scan deadline has passed', async () => {
        const calls: FetchCall[] = [];
        const result = await resolveEntryUrl('https://late.example.com/', { deadline: new ScanDeadline(0), fetchImpl: fakeFetch({}, calls), log: () => undefined });

        expect(calls).toHaveLength(0);
        expect(result.candidates[0]).toBe('https://late.example.com/');
    });
});

describe('proxy handling', () => {
    const proxyArgs = ['--disable-gpu', '--proxy-server=http://scanuser:s3cretPass@proxy.internal.example:3128'];
    const leaks = (text: string) => ['scanuser', 's3cretPass', 'proxy.internal.example', '3128'].some(secret => text.includes(secret));

    it('routes requests through the dispatcher and never logs the proxy', async () => {
        const logs: string[] = [];
        const calls: FetchCall[] = [];
        const dispatcher = { kind: 'fake-proxy' };
        const leakingFetch: FetchLike = async (url, init) => {
            calls.push({ url, init });
            throw new Error('connect failed via http://scanuser:s3cretPass@proxy.internal.example:3128');
        };
        const result = await resolveEntryUrl('https://noblespondcanton.com/', {
            deadline: new ScanDeadline(60000),
            extraChromiumArgs: proxyArgs,
            fetchImpl: leakingFetch,
            createProxyDispatcher: () => dispatcher,
            log: message => logs.push(message)
        });

        expect(calls.every(c => c.init.dispatcher === dispatcher)).toBe(true);
        expect(result.proxied).toBe(true);
        expect(logs.length).toBeGreaterThan(0);
        expect(logs.some(leaks)).toBe(false);
        expect(leaks(JSON.stringify(result))).toBe(false);
    });

    it('logs that it ran unproxied, without the proxy, when no dispatcher can be built', async () => {
        const logs: string[] = [];
        const result = await resolveWith('https://hudsonvalleyec.com/', { 'https://hudsonvalleyec.com/': page('x') }, {
            extraChromiumArgs: proxyArgs,
            createProxyDispatcher: () => null,
            log: message => logs.push(message)
        });

        expect(result.proxied).toBe(false);
        expect(logs.some(l => l.includes('without proxy'))).toBe(true);
        expect(logs.some(leaks)).toBe(false);
    });

    it('separates credentials from the proxy endpoint', () => {
        const parsed = parseProxyArg(proxyArgs);

        expect(parsed).toMatchObject({ uri: 'http://proxy.internal.example:3128', token: `Basic ${Buffer.from('scanuser:s3cretPass').toString('base64')}` });
        expect(parseProxyArg(['--proxy-server=socks5://h:1'])).toBe('unsupported');
        expect(parseProxyArg([])).toBeNull();
    });
});

describe('candidate list', () => {
    it('orders and de-duplicates variants, adding origin roots last', () => {
        const candidates = buildEntryCandidates('https://www.hammonsproducts.com/shop?x=1', {
            finalUrl: 'https://black-walnuts.com/shop',
            failure: null
        });

        expect(candidates).toEqual([
            'https://black-walnuts.com/shop',
            'https://www.hammonsproducts.com/shop?x=1',
            'https://www.black-walnuts.com/shop',
            'https://black-walnuts.com/',
            'https://www.hammonsproducts.com/',
            'https://www.black-walnuts.com/'
        ]);
    });

    it.each([
        ['example.com', 'www.example.com'],
        ['www.example.com', 'example.com'],
        ['www.example.co.uk', 'example.co.uk'],
        ['api.example.com', null],
        ['www.api.example.com', null],
        ['127.0.0.1', null],
        ['localhost', null]
    ])('swaps %s to %s', (host, expected) => {
        expect(swapWwwHost(host)).toBe(expected);
    });

    it('never falls back to the parent domain of a subdomain', () => {
        const candidates = buildEntryCandidates('https://api.example.com/', { finalUrl: 'https://api.example.com/', failure: null });

        expect(candidates).toEqual(['https://api.example.com/']);
    });
});

describe('findDocumentRedirect', () => {
    const base = 'https://site.example/';
    it.each([
        ['<META CONTENT="0;URL=\'https://other.example/\'" HTTP-EQUIV="Refresh">', 'https://other.example/'],
        ['<script>window.location.href = "/moved";</script>', 'https://site.example/moved'],
        ['<script>location.replace(\'https://other.example/x\')</script>', 'https://other.example/x'],
        ['<meta http-equiv="refresh" content="600; url=/later">', null],
        ['<meta http-equiv="refresh" content="300">', null],
        ['<script>var location = "/not-a-redirect";</script>', null],
        ['<script>if (location.href == "/x") {}</script>', null]
    ])('reads %s', (html, expected) => {
        expect(findDocumentRedirect(html, base)).toBe(expected);
    });
});

describe('resolveEntryUrl against local servers', () => {
    let server: Server;
    let port: number;
    const quiet = { deadline: new ScanDeadline(60000), log: () => undefined };

    beforeAll(done => {
        const app = express();
        app.get('/to-localhost', (_req, res) => res.redirect(301, `http://localhost:${port}/landing`));
        app.get('/landing', (_req, res) => res.send('<html>landing</html>'));
        app.get('/loop/:n', (req, res) => res.redirect(302, `/loop/${Number(req.params.n) + 1}`));
        app.get('/refresh', (_req, res) => res.send('<html><head><meta http-equiv="refresh" content="0;url=/landing"></head></html>'));
        server = app.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            done();
        });
    });

    afterAll(done => {
        server.close(() => done());
    });

    it('follows a redirect to another host', async () => {
        const result = await resolveEntryUrl(`http://127.0.0.1:${port}/to-localhost`, quiet);

        expect(result.finalUrl).toBe(`http://localhost:${port}/landing`);
        expect(result.status).toBe(200);
    });

    it('stops a redirect loop at the hop limit', async () => {
        const result = await resolveEntryUrl(`http://127.0.0.1:${port}/loop/0`, quiet);

        expect(result.hopLimitReached).toBe(true);
        expect(result.hops).toHaveLength(11);
        expect(result.candidates[1]).toBe(`http://127.0.0.1:${port}/loop/0`);
    });

    it('follows a meta refresh', async () => {
        const result = await resolveEntryUrl(`http://127.0.0.1:${port}/refresh`, quiet);

        expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/landing`);
    });

    it('offers plain http when the host does not speak TLS', async () => {
        const result = await resolveEntryUrl(`https://127.0.0.1:${port}/landing`, quiet);

        expect(result.failure?.kind).toBe('tls');
        expect(result.candidates).toContain(`http://127.0.0.1:${port}/landing`);
    });
});

describe('openEntryPage', () => {
    const urlPage = (outcomes: Record<string, number | Error>): NavigablePage<NavigationResponse> & { visited: string[] } => {
        const visited: string[] = [];
        return {
            visited,
            goto: async url => {
                visited.push(url);
                const outcome = outcomes[url] ?? new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
                if (outcome instanceof Error) {
                    throw outcome;
                }
                return { status: () => outcome };
            },
            createCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined })
        };
    };
    const navOptions = (deadline = new ScanDeadline(60000)): NavigationOptions => ({
        waitUntil: 'load', navigationTimeoutMs: 1000, defaultTimeout: 1000, maxRetries: 2, deadline, retryBackoffMs: 1, log: () => undefined
    });

    it('moves on from a 404 apex to the www candidate', async () => {
        const fake = urlPage({ 'https://sunmerger.com/': 404, 'https://www.sunmerger.com/': 200 });
        const result = await openEntryPage(fake, ['https://sunmerger.com/', 'https://www.sunmerger.com/'], navOptions());

        expect(result.response?.status()).toBe(200);
        expect(result.attempts).toEqual([
            { url: 'https://sunmerger.com/', outcome: 'http_status', status: 404 },
            { url: 'https://www.sunmerger.com/', outcome: 'success', status: 200 }
        ]);
    });

    it('records every failed attempt and the last HTTP status', async () => {
        const fake = urlPage({ 'https://a.example/': 403, 'http://a.example/': new Error('net::ERR_CONNECTION_REFUSED') });
        const result = await openEntryPage(fake, ['https://a.example/', 'http://a.example/'], navOptions());

        expect(result.response).toBeNull();
        expect(result.attempts.map(a => a.outcome)).toEqual(['http_status', 'error']);
        expect(lastHttpStatus(result.attempts)).toBe(403);
    });

    it('skips other candidates on a host the browser could not resolve', async () => {
        const fake = urlPage({});
        await openEntryPage(fake, ['https://dead.example/', 'https://dead.example/other', 'https://www.dead.example/'], navOptions());

        expect(fake.visited).toEqual(['https://dead.example/', 'https://dead.example/', 'https://www.dead.example/']);
    });

    it('records nothing when the deadline has already passed', async () => {
        const result = await openEntryPage(urlPage({}), ['https://x.example/'], navOptions(new ScanDeadline(0)));

        expect(result).toEqual({ response: null, attempts: [], deadlineReached: true, httpErrors: [] });
    });
});
