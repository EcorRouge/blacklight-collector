import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { collect } from '../src/collector';
import { CollectorOptions } from '../src/collector-config';

// puppeteer-har pulls in an ESM-only dependency that jest cannot load; HAR capture is not under test.
jest.mock('puppeteer-har', () => jest.fn());
jest.setTimeout(120000);

interface Site {
    base: string;
    close: () => Promise<void>;
}

/** A throwaway site on its own loopback port, so discovery sees a distinct origin per scenario. */
const startSite = (routes: (app: express.Express) => void): Promise<Site> =>
    new Promise(resolve => {
        const app = express();
        routes(app);
        const server: Server = app.listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            resolve({
                base,
                close: () =>
                    new Promise<void>(done => {
                        server.close(() => done());
                        // Hanging test routes and browser keep-alive sockets would otherwise hold the server open.
                        server.closeAllConnections();
                    })
            });
        });
    });

const html = (body: string, head = '') => `<html><head><title>t</title>${head}</head><body>${body}</body></html>`;

let outDir: string;
let site: Site | null = null;

const scan = (url: string, extra: CollectorOptions = {}) =>
    collect(url, { outDir, numPages: 3, captureHar: false, saveScreenshots: false, scanTimeoutMs: 60000, navigationTimeoutMs: 10000, ...extra });

const serve = async (routes: (app: express.Express) => void) => {
    site = await startSite(routes);
    return site.base;
};

const inspectionFile = () => JSON.parse(readFileSync(join(outDir, 'inspection.json'), 'utf-8'));

beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'bl-partial-'));
});

afterEach(async () => {
    rmSync(outDir, { recursive: true, force: true });
    if (site) {
        await site.close();
        site = null;
    }
});

describe('fallback page discovery', () => {
    it('starts from /login when the landing page is a 404 and reports a partial success', async () => {
        const base = await serve(app => {
            app.get('/login', (_req, res) => res.send(html('sign in')));
        });

        const result = await scan(`${base}/`);

        expect(result).toMatchObject({ status: 'success', partial: true, uri_dest: `${base}/login`, pages_succeeded: [`${base}/login`] });
        expect(result.pages_failed).toContainEqual({ url: `${base}/`, status: 404 });
        expect(result.entry_attempts[0]).toEqual({ url: `${base}/`, outcome: 'http_status', status: 404, source: 'candidate' });
        expect(result.entry_attempts[result.entry_attempts.length - 1]).toEqual({ url: `${base}/login`, outcome: 'success', status: 200, source: 'common_path' });
        expect(inspectionFile()).toMatchObject({ partial: true, pages_succeeded: [`${base}/login`] });
        expect(existsSync(join(outDir, 'browser-cookies.json'))).toBe(true);
    });

    it('follows the robots.txt sitemap and its index to a page that loads', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) => res.status(403).send(html('blocked')));
            app.get('/robots.txt', (_req, res) => res.type('text').send(`User-agent: *\nSitemap: ${base}/maps/index.xml\n`));
            app.get('/maps/index.xml', (_req, res) =>
                res.type('xml').send(`<sitemapindex><sitemap><loc>${base}/maps/pages.xml</loc></sitemap></sitemapindex>`)
            );
            app.get('/maps/pages.xml', (_req, res) => res.type('xml').send(`<urlset><url><loc>${base}/from-sitemap</loc></url></urlset>`));
            app.get('/from-sitemap', (_req, res) => res.send(html('listed page')));
        });

        const result = await scan(`${base}/`);

        expect(result).toMatchObject({ status: 'success', partial: true, pages_succeeded: [`${base}/from-sitemap`] });
        expect(result.entry_attempts.map(a => a.source)).toEqual(['candidate', 'sitemap']);
    });

    it('uses the links of the error page first', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) => res.status(404).send(html('<a href="/welcome">try this</a>')));
            app.get('/welcome', (_req, res) => res.send(html('welcome')));
        });

        const result = await scan(`${base}/`);

        expect(result.status).toBe('success');
        expect(result.entry_attempts[1]).toEqual({ url: `${base}/welcome`, outcome: 'success', status: 200, source: 'error_page_link' });
        expect(result.pages_succeeded).toEqual([`${base}/welcome`]);
    });
});

describe('partial results', () => {
    it('reports success with every failed link when only the landing page loads', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) => res.send(html('<a href="/missing-1">a</a><a href="/missing-2">b</a>')));
        });

        const result = await scan(`${base}/`);

        expect(result).toMatchObject({ status: 'success', partial: true, pages_succeeded: [`${base}/`] });
        expect(result.pages_failed).toEqual(
            expect.arrayContaining([{ url: `${base}/missing-1`, status: 404 }, { url: `${base}/missing-2`, status: 404 }])
        );
        expect(result.pages_failed).toHaveLength(2);
    });

    it('keeps the collected data when the scan deadline hits mid-crawl', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) =>
                res.send(html('<a href="/slow">slow</a>', '<script>document.cookie = "visited=yes; path=/";</script>'))
            );
            app.get('/slow', () => undefined);
        });

        const result = await scan(`${base}/`, { scanTimeoutMs: 8000, navigationTimeoutMs: 60000 });

        expect(result).toMatchObject({ status: 'success', partial: true, scan_deadline_reached: true, pages_succeeded: [`${base}/`] });
        expect(result.pages_failed).toEqual([{ url: `${base}/slow`, error: 'Scan time budget exhausted' }]);
        expect(result.reports.cookies.map(c => c.name)).toContain('visited');
        expect(inspectionFile().scan_deadline_reached).toBe(true);
        expect(existsSync(join(outDir, 'browser-cookies.json'))).toBe(true);
    });

    it('fails with the legacy message, every attempt and every failed page when nothing loads', async () => {
        const base = await serve(() => undefined);

        const result = await scan(`${base}/`);

        expect(result).toMatchObject({ status: 'failed', page_response: 'Initial page returned non-2xx status: 404', pages_succeeded: [] });
        expect(result.entry_attempts.map(a => a.source)).toEqual(['candidate', ...Array(6).fill('common_path')]);
        expect(result.pages_failed).toHaveLength(7);
        expect(existsSync(join(outDir, 'inspection.json'))).toBe(false);
    });

    it('fails when no page loads even though the error pages produced events', async () => {
        const base = await serve(app => {
            // Bot walls and branded error pages run scripts of their own; that says nothing about the site.
            app.use((_req, res) => res.status(404).send(html('not here', '<script>document.cookie = "edge=1; path=/";</script>')));
        });

        const result = await scan(`${base}/`);

        expect(result).toEqual({
            status: 'failed',
            page_response: 'Initial page returned non-2xx status: 404',
            entry_attempts: expect.arrayContaining([{ url: `${base}/`, outcome: 'http_status', status: 404, source: 'candidate' }]),
            pages_succeeded: [],
            pages_failed: expect.arrayContaining([{ url: `${base}/`, status: 404 }, { url: `${base}/login`, status: 404 }])
        });
        expect(result.entry_attempts).toHaveLength(7);
        expect(result.pages_failed).toHaveLength(7);
        expect(existsSync(join(outDir, 'inspection.json'))).toBe(false);
    });
});

describe('zero-event pages', () => {
    it('are a success with empty reports and no_events set', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) => res.send(html('plain page')));
        });

        const result = await scan(`${base}/`);

        expect(result).toMatchObject({ status: 'success', partial: false, no_events: true, pages_failed: [] });
        expect(result.reports).toEqual({
            behaviour_event_listeners: {},
            canvas_fingerprinters: { data_url: {}, fingerprinters: [], styles: {}, texts: {} },
            canvas_font_fingerprinters: { canvas_font: {}, text_measure: {} },
            cookies: [],
            fb_pixel_events: [],
            key_logging: {},
            session_recorders: {},
            third_party_trackers: []
        });
        expect(inspectionFile().no_events).toBe(true);
    });
});

describe('a healthy crawl', () => {
    it('is not partial and keeps every previous field', async () => {
        // Server-side record of the pages requested: if a sampled page ever fails here again, the first
        // assertion tells whether the browser's request reached the server at all.
        const served: string[] = [];
        const base = await serve(app => {
            app.use((req, _res, next) => {
                served.push(req.path);
                next();
            });
            app.get('/', (_req, res) =>
                res.send(html('<a href="/p1">1</a><a href="/p2">2</a>', '<script>document.cookie = "sid=1; path=/";</script>'))
            );
            app.get(['/p1', '/p2'], (_req, res) => res.send(html('page')));
        });

        const result = await scan(`${base}/`, { numPages: 2 });

        expect(served).toEqual(expect.arrayContaining(['/', '/p1', '/p2']));

        expect(result).toMatchObject({ status: 'success', partial: false, no_events: false, pages_failed: [], uri_ins: `${base}/`, uri_dest: `${base}/` });
        expect(result.pages_succeeded).toEqual(expect.arrayContaining([`${base}/`, `${base}/p1`, `${base}/p2`]));
        expect(result.pages_succeeded).toHaveLength(3);
        expect(result.browsing_history).toHaveLength(3);
        expect(result.scan_deadline_reached).toBeUndefined();
        expect(Object.keys(result)).toEqual(expect.arrayContaining([
            'title', 'page_title', 'uri_ins', 'uri_dest', 'uri_redirects', 'secure_connection', 'host', 'config', 'browser', 'script',
            'start_time', 'end_time', 'entry_attempts', 'original_domain', 'final_domain', 'entry_redirected', 'hosts', 'reports'
        ]));
        expect(result.entry_attempts).toEqual([{ url: `${base}/`, outcome: 'success', status: 200, source: 'candidate' }]);
    });
});

describe('credential scrubbing', () => {
    it('never puts proxy credentials in the result or inspection.json', async () => {
        const base = await serve(app => {
            app.get('/', (_req, res) => res.send(html('proxied')));
        });

        const result = await scan(`${base}/`, {
            // Chromium never sends loopback traffic through a proxy, so the scan still reaches the site.
            extraChromiumArgs: ['--proxy-server=http://user:s3cret@127.0.0.1:9'],
            extraPuppeteerOptions: { protocolTimeout: 180000, ignoreDefaultArgs: ['--proxy-server=user:s3cret@127.0.0.1:9'] }
        });

        expect(result.status).toBe('success');
        expect(result.config.extraChromiumArgs).toEqual(['--proxy-server=http://***@127.0.0.1:9']);
        expect(result.config.extraPuppeteerOptions).toEqual({ protocolTimeout: 180000, ignoreDefaultArgs: ['--proxy-server=***@127.0.0.1:9'] });
        expect(JSON.stringify(result)).not.toContain('s3cret');
        expect(readFileSync(join(outDir, 'inspection.json'), 'utf-8')).not.toContain('s3cret');
    });
});
