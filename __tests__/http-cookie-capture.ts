import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { collect } from '../src/collector';
import { DEFAULT_OPTIONS } from '../src/collector-config';
import { matchCookiesToEvents, setupHttpCookieCapture } from '../src/inspectors/cookies';
import { defaultPuppeteerBrowserOptions } from '../src/pptr-utils/default';

// puppeteer-har pulls in an ESM-only dependency that jest cannot load; HAR capture is not under test.
jest.mock('puppeteer-har', () => jest.fn());
jest.setTimeout(120000);

// Registrable *.test hostnames resolved to loopback, so first- and third-party are distinct sites
// for both Chrome and tldts without touching the internet.
const HOST_RULES = '--host-resolver-rules=MAP *.test 127.0.0.1';

interface Site {
    port: number;
    close: () => Promise<void>;
}

const startSite = (routes: (app: express.Express) => void): Promise<Site> =>
    new Promise(resolve => {
        const app = express();
        routes(app);
        const server: Server = app.listen(0, '127.0.0.1', () => {
            resolve({
                port: (server.address() as AddressInfo).port,
                close: () =>
                    new Promise<void>(done => {
                        server.close(() => done());
                        server.closeAllConnections();
                    })
            });
        });
    });

const html = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

let first: Site;
let tracker: Site;
const firstUrl = (path: string) => `http://www.first.test:${first.port}${path}`;
const trackerUrl = (path: string) => `http://tracker.test:${tracker.port}${path}`;

beforeAll(async () => {
    tracker = await startSite(app => {
        app.get('/pixel', (_req, res) => {
            res.append('Set-Cookie', 'tid=abc');
            res.send('ok');
        });
    });
    first = await startSite(app => {
        app.get('/one', (_req, res) => {
            res.append('Set-Cookie', 'session=s1; Path=/; HttpOnly');
            res.send(html('one'));
        });
        app.get('/two', (_req, res) => {
            res.append('Set-Cookie', 'a=1; Path=/; HttpOnly');
            res.append('Set-Cookie', 'b=2; Domain=.first.test; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
            res.send(html('two'));
        });
        app.get('/embeds-tracker', (_req, res) => res.send(html(`<img src="${trackerUrl('/pixel')}">`)));
        app.get('/plain', (_req, res) => res.send(html('plain')));
    });
});

afterAll(async () => {
    await first.close();
    await tracker.close();
});

describe('setupHttpCookieCapture', () => {
    let browser: Browser;
    let page: Page;
    let events: any[];

    beforeEach(async () => {
        browser = await puppeteer.launch({ ...defaultPuppeteerBrowserOptions, args: [...defaultPuppeteerBrowserOptions.args, HOST_RULES] });
        page = (await browser.pages())[0];
        events = [];
        await setupHttpCookieCapture(page, e => events.push(e));
    });

    afterEach(async () => {
        await browser.close();
    });

    // What the report sees: events pass through the JSON log file before they are matched.
    const logged = () => events.map(e => JSON.parse(JSON.stringify(e)));

    it('records a single Set-Cookie header from the document response', async () => {
        await page.goto(firstUrl('/one'), { waitUntil: 'networkidle0' });

        expect(logged()).toEqual([
            {
                data: [expect.objectContaining({ key: 'session', value: 's1', domain: 'www.first.test', path: '/', httpOnly: true })],
                raw: 'session=s1; Path=/; HttpOnly',
                stack: [{ fileName: firstUrl('/one'), source: `set in Set-Cookie HTTP response header for ${firstUrl('/one')}` }],
                type: 'Cookie.HTTP',
                url: firstUrl('/one')
            }
        ]);
    });

    it('records every cookie when a response sends two Set-Cookie headers', async () => {
        await page.goto(firstUrl('/two'), { waitUntil: 'networkidle0' });

        const [event] = logged();
        expect(events).toHaveLength(1);
        expect(event.raw.split('\n')).toHaveLength(2);
        expect(event.data).toEqual([
            expect.objectContaining({ key: 'a', value: '1', domain: 'www.first.test', path: '/', httpOnly: true }),
            expect.objectContaining({ key: 'b', value: '2', domain: 'first.test', path: '/', expires: '2037-10-21T07:28:00.000Z' })
        ]);
    });

    it('attributes a third-party response cookie to its own host and to the visited page', async () => {
        await page.goto(firstUrl('/embeds-tracker'), { waitUntil: 'networkidle0' });

        const [event] = logged();
        expect(events).toHaveLength(1);
        expect(event).toMatchObject({ url: firstUrl('/embeds-tracker'), stack: [{ fileName: trackerUrl('/pixel') }] });
        expect(event.data).toEqual([expect.objectContaining({ key: 'tid', value: 'abc', domain: 'tracker.test', path: '/' })]);
    });

    it('records nothing for responses without Set-Cookie', async () => {
        await page.goto(firstUrl('/plain'), { waitUntil: 'networkidle0' });

        expect(events).toEqual([]);
    });

    it('lets the cookie report tell first- from third-party header cookies when the browser stored none', async () => {
        await page.goto(firstUrl('/embeds-tracker'), { waitUntil: 'networkidle0' });
        await page.goto(firstUrl('/one'), { waitUntil: 'networkidle0' });

        const report = matchCookiesToEvents([], logged(), 'first.test');

        expect(report).toEqual([
            expect.objectContaining({ name: 'tid', domain: 'tracker.test', type: 'http', third_party: true, script: trackerUrl('/pixel') }),
            expect.objectContaining({ name: 'session', domain: 'www.first.test', type: 'http', third_party: false, script: firstUrl('/one') })
        ]);
    });
});

describe('collect with Set-Cookie headers', () => {
    let outDir: string;

    beforeEach(() => {
        outDir = mkdtempSync(join(tmpdir(), 'bl-http-cookie-'));
    });

    afterEach(() => {
        rmSync(outDir, { recursive: true, force: true });
    });

    it('logs the header cookies and reports the stored ones as set over HTTP', async () => {
        const result = await collect(firstUrl('/two'), {
            outDir,
            numPages: 1,
            captureHar: false,
            saveScreenshots: false,
            blTests: ['cookies'],
            extraChromiumArgs: [...DEFAULT_OPTIONS.extraChromiumArgs, HOST_RULES]
        });

        const httpEvents = readFileSync(join(outDir, 'inspection-log.ndjson'), 'utf-8')
            .split('\n')
            .filter(line => line)
            .map(line => JSON.parse(line).message)
            .filter(message => message?.type === 'Cookie.HTTP');
        expect(httpEvents).toEqual([expect.objectContaining({ url: firstUrl('/two'), stack: [expect.objectContaining({ fileName: firstUrl('/two') })] })]);
        expect(result.status).toBe('success');
        expect(result.reports.cookies).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'a', domain: 'www.first.test', type: 'http', third_party: false }),
                expect.objectContaining({ name: 'b', domain: 'first.test', type: 'http', third_party: false })
            ])
        );
    });
});
