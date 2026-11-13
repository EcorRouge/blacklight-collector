import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import puppeteer, { Browser, HTTPResponse, Page } from 'puppeteer';
import { collect } from '../src/collector';
import { defaultPuppeteerBrowserOptions } from '../src/pptr-utils/default';
import { classifyStatus, navigateWithinBudget, NavigationOptions } from '../src/pptr-utils/navigate';
import { runPageWork } from '../src/pptr-utils/page-work';
import { ScanDeadline } from '../src/pptr-utils/scan-deadline';
import { Global } from '../src/types';
import { hangingPage, newStats, statusPage, tracking } from './shared/navigation-fakes';

// puppeteer-har pulls in an ESM-only dependency that jest cannot load; HAR capture is not under test.
jest.mock('puppeteer-har', () => jest.fn());

declare var global: Global;
jest.setTimeout(90000);

const silent = () => undefined;

const options = (overrides: Partial<NavigationOptions>): NavigationOptions => ({
    waitUntil: 'networkidle2',
    navigationTimeoutMs: 45000,
    defaultTimeout: 600000,
    maxRetries: 3,
    deadline: new ScanDeadline(60000),
    retryBackoffMs: 10,
    log: silent,
    ...overrides
});

describe('classifyStatus', () => {
    it.each([200, 204, 304])('treats %i as success', status => {
        expect(classifyStatus(status)).toBe('success');
    });
    it.each([400, 401, 404, 405, 410, 451])('never retries %i', status => {
        expect(classifyStatus(status)).toBe('permanent');
    });
    it.each([403, 429, 500, 503, 522])('retries %i once', status => {
        expect(classifyStatus(status)).toBe('retry_once');
    });
});

describe('navigateWithinBudget with a fake page', () => {
    it('falls back to domcontentloaded only after the timed-out goto settled and was stopped', async () => {
        const stats = newStats();
        const outcome = await navigateWithinBudget(
            tracking(hangingPage, stats),
            'http://hang.test',
            options({ navigationTimeoutMs: 50, maxRetries: 2 })
        );

        expect(outcome.kind).toBe('network_error');
        expect(stats.maxInFlight).toBe(1);
        expect(stats.waitUntils).toEqual(['networkidle2', 'domcontentloaded', 'networkidle2', 'domcontentloaded']);
        expect(stats.stops).toBe(4);
    });

    it('caps each goto by the remaining scan budget', async () => {
        const stats = newStats();
        let now = 0;
        const deadline = new ScanDeadline(1000, () => now);
        now = 700;
        await navigateWithinBudget(tracking(statusPage([200]), stats), 'http://ok.test', options({ deadline }));

        expect(stats.timeouts).toEqual([300]);
    });

    it('reports the deadline without navigating once the budget is spent', async () => {
        const stats = newStats();
        const deadline = new ScanDeadline(0);
        const outcome = await navigateWithinBudget(tracking(statusPage([200]), stats), 'http://ok.test', options({ deadline }));

        expect(outcome.kind).toBe('deadline');
        expect(stats.gotoCalls).toBe(0);
    });

    it('gives up on a 403 after exactly one retry', async () => {
        const stats = newStats();
        const outcome = await navigateWithinBudget(tracking(statusPage([403, 403, 200]), stats), 'http://wall.test', options({}));

        expect(outcome.kind).toBe('http_error');
        expect(stats.gotoCalls).toBe(2);
    });
});

describe('navigateWithinBudget against the test server', () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
        browser = await puppeteer.launch(defaultPuppeteerBrowserOptions);
    });
    beforeEach(async () => {
        page = await browser.newPage();
    });
    afterEach(async () => {
        await page.close();
    });
    afterAll(async () => {
        await browser.close();
    });

    it('ends a slow page within the cap and never overlaps two gotos', async () => {
        const stats = newStats();
        const started = Date.now();
        const outcome = await navigateWithinBudget<HTTPResponse>(
            tracking<HTTPResponse>(page, stats),
            `${global.__DEV_SERVER__}/nav/slow?ms=30000`,
            options({ navigationTimeoutMs: 1500, maxRetries: 1 })
        );

        expect(outcome.kind).toBe('network_error');
        expect(Date.now() - started).toBeLessThan(5000);
        expect(stats.gotoCalls).toBe(2);
        expect(stats.maxInFlight).toBe(1);
    });

    it('attempts a 404 exactly once', async () => {
        const stats = newStats();
        const outcome = await navigateWithinBudget<HTTPResponse>(
            tracking<HTTPResponse>(page, stats),
            `${global.__DEV_SERVER__}/nav/does-not-exist.html`,
            options({})
        );

        expect(outcome.kind).toBe('http_error');
        expect(outcome.response?.status()).toBe(404);
        expect(stats.gotoCalls).toBe(1);
    });

    it('recovers from a 503 with exactly one retry', async () => {
        const stats = newStats();
        const outcome = await navigateWithinBudget<HTTPResponse>(
            tracking<HTTPResponse>(page, stats),
            `${global.__DEV_SERVER__}/nav/flaky/retry-once-${Date.now()}`,
            options({ retryBackoffMs: 1000 })
        );

        expect(outcome.kind).toBe('success');
        expect(outcome.response?.status()).toBe(200);
        expect(stats.gotoCalls).toBe(2);
    });

    it('tolerates the page navigating away during per-page work', async () => {
        await page.goto(`${global.__DEV_SERVER__}/index.html`);
        const navigateAway = async () => {
            await page.evaluate(() => {
                window.location.href = '/input-form.html';
                return new Promise(() => undefined);
            });
        };

        await expect(runPageWork('index.html', navigateAway, silent)).resolves.toBe(false);
    });

    it('re-throws errors that are not a destroyed execution context', async () => {
        const failing = async () => {
            throw new Error('boom');
        };

        await expect(runPageWork('index.html', failing, silent)).rejects.toThrow('boom');
    });
});

describe('collect with a scan deadline', () => {
    let outDir: string;

    beforeAll(() => {
        outDir = mkdtempSync(join(tmpdir(), 'bl-navigation-'));
    });
    afterAll(() => {
        rmSync(outDir, { recursive: true, force: true });
    });

    it('stops browsing when the budget runs out mid-crawl and still reports success', async () => {
        const result = await collect(`${global.__DEV_SERVER__}/nav-crawl.html`, {
            outDir,
            numPages: 3,
            captureHar: false,
            saveScreenshots: false,
            scanTimeoutMs: 12000,
            navigationTimeoutMs: 60000
        });

        expect(result.status).toBe('success');
        expect(result.scan_deadline_reached).toBe(true);
    });

    it('fails with a budget message when the deadline passes before the first page loads', async () => {
        const result = await collect(`${global.__DEV_SERVER__}/nav-crawl.html`, {
            outDir,
            captureHar: false,
            scanTimeoutMs: 1
        });

        expect(result).toEqual({ status: 'failed', page_response: 'Scan time budget exhausted' });
    });
});
