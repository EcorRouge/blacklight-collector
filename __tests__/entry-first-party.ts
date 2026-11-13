import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { collect } from '../src/collector';
import { matchCookiesToEvents } from '../src/inspectors/cookies';
import { generateReport } from '../src/parser';
import { BlacklightEvent } from '../src/types';

// puppeteer-har pulls in an ESM-only dependency that jest cannot load; HAR capture is not under test.
jest.mock('puppeteer-har', () => jest.fn());
jest.setTimeout(120000);

const trackingEvent = (url: string): BlacklightEvent => ({ type: 'TrackingRequest', url, stack: [], data: { query: {}, filter: '', listName: '' } });

describe('generateReport with an original and a final domain', () => {
    const events = [trackingEvent('https://cdn.new-brand.com/t.js'), trackingEvent('https://old-brand.com/t.js'), trackingEvent('https://tracker.net/p')];

    it('treats both domains as first party when the final domain is given', () => {
        const report = generateReport('third_party_trackers', events, null, 'old-brand.com', ['new-brand.com']);

        expect(report.map(e => e.url)).toEqual(['https://tracker.net/p']);
    });

    it('keeps the single-domain behaviour when no additional domain is given', () => {
        const report = generateReport('third_party_trackers', events, null, 'old-brand.com');

        expect(report.map(e => e.url)).toEqual(['https://cdn.new-brand.com/t.js', 'https://tracker.net/p']);
    });

    it('marks cookies of the final domain as first party', () => {
        const cookie = { name: 'sid', domain: 'new-brand.com', path: '/', value: '1', expires: 0 };

        expect(matchCookiesToEvents([cookie], [], 'old-brand.com', ['new-brand.com'])[0].third_party).toBe(false);
        expect(matchCookiesToEvents([cookie], [], 'old-brand.com')[0].third_party).toBe(true);
    });
});

describe('collect first-party classification after the entry redirect', () => {
    let server: Server;
    let port: number;
    let outDir: string;

    // Chromium maps these names to the local server; the resolver's own lookups fail and fall back.
    const browserArgs = () => ['--host-resolver-rules=MAP *.test 127.0.0.1'];
    const scan = (url: string) =>
        collect(url, { outDir, numPages: 0, captureHar: false, saveScreenshots: false, scanTimeoutMs: 60000, extraChromiumArgs: browserArgs() });

    beforeAll(done => {
        outDir = mkdtempSync(join(tmpdir(), 'bl-entry-'));
        const app = express();
        app.get('/', (req, res) => {
            if (req.hostname === 'old-brand.test') {
                res.redirect(301, `http://new-brand.test:${port}/`);
                return;
            }
            res.send(`<html><head><title>${req.hostname}</title>
                <script src="http://cdn.${req.hostname}:${port}/app.js"></script>
                <script src="http://tracker.test:${port}/pixel.js"></script>
                </head><body>home</body></html>`);
        });
        app.get('/app.js', (_req, res) => res.type('js').send('document.cookie = "sid=1";'));
        app.get('/pixel.js', (_req, res) => res.type('js').send('window.addEventListener("keyup", function () {});'));
        server = app.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            done();
        });
    });

    afterAll(done => {
        rmSync(outDir, { recursive: true, force: true });
        server.close(() => done());
    });

    it('counts hosts of the domain the site moved to as first party', async () => {
        const result = await scan(`http://old-brand.test:${port}/`);

        expect(result.status).toBe('success');
        expect(result).toMatchObject({
            uri_ins: `http://old-brand.test:${port}/`,
            uri_dest: `http://new-brand.test:${port}/`,
            original_domain: 'old-brand.test',
            final_domain: 'new-brand.test',
            entry_redirected: true
        });
        expect(result.hosts.requests.first_party).toEqual(expect.arrayContaining(['new-brand.test', 'cdn.new-brand.test']));
        expect(result.hosts.requests.third_party).toEqual(['tracker.test']);
        expect(result.entry_attempts[result.entry_attempts.length - 1]).toMatchObject({ outcome: 'success', status: 200 });
    });

    it('keeps the classification unchanged when the site stays on its domain', async () => {
        const result = await scan(`http://same-site.test:${port}/`);

        expect(result).toMatchObject({ status: 'success', original_domain: 'same-site.test', final_domain: 'same-site.test', entry_redirected: false });
        expect(result.hosts.requests.first_party).toEqual(expect.arrayContaining(['same-site.test', 'cdn.same-site.test']));
        expect(result.hosts.requests.third_party).toEqual(['tracker.test']);
    });
});
