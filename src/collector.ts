import os from 'os';
import { join } from 'path';
import puppeteer, { Browser, Page, PuppeteerLifeCycleEvent } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { buildOutput, CollectorConfig, CollectorOptions, DEFAULT_OPTIONS } from './collector-config';
import { crawlFromLanding } from './crawl';
import { CrawlProgress } from './crawl-progress';
import { finalizeResult } from './finalize-result';
import { getLogger } from './helpers/logger';
import { clearDir, closeBrowser } from './helpers/utils';
import { captureBrowserCookies, clearCookiesCache, setupHttpCookieCapture } from './inspectors/cookies';
import { setupBlacklightInspector } from './inspectors/inspector';
import { setupKeyLoggingInspector } from './inspectors/key-logging';
import { setupSessionRecordingInspector } from './inspectors/session-recording';
import { setUpThirdPartyTrackersInspector } from './inspectors/third-party-trackers';
import { reachLandingPage } from './landing';
import { defaultPuppeteerBrowserOptions } from './pptr-utils/default';
import { dedupLinks, getSocialLinks } from './pptr-utils/get-links';
import { NavigationOptions } from './pptr-utils/navigate';
import { ScanDeadline } from './pptr-utils/scan-deadline';
import { SiteHosts } from './site-hosts';
import { LinkObject } from './types';

export { CollectorOptions } from './collector-config';

/**
 * Cookies and the HAR are evidence for the report even when the crawl ended early, so they are
 * saved whatever happened, as long as the browser is still there to ask.
 */
const saveBrowserArtifacts = async (page: Page, outDir: string, stopHar: (() => Promise<void>) | null) => {
    try {
        await captureBrowserCookies(page, outDir);
    } catch (error) {
        console.log(`Could not save browser cookies: ${error.message}`);
    }
    if (stopHar) {
        try {
            await stopHar();
        } catch (error) {
            console.log(`Could not save the HAR: ${error.message}`);
        }
    }
};

export const collect = async (inUrl: string, options: CollectorOptions) => {
    const args: CollectorConfig = { ...DEFAULT_OPTIONS, ...options };
    const deadline = new ScanDeadline(args.scanTimeoutMs);
    clearDir(args.outDir);
    const site = new SiteHosts(inUrl);
    const progress = new CrawlProgress();
    const { logger, logFilePath } = getLogger({ outDir: args.outDir, quiet: args.quiet });
    const output = buildOutput(inUrl, args);
    const chromeCrashed = () => ({ status: 'failed', page_response: 'Chrome crashed', pages_succeeded: [], pages_failed: [] });

    let browser: Browser;
    let stopHar: (() => Promise<void>) | null = null;
    const userDataDir = args.saveBrowserProfile ? join(args.outDir, 'browser-profile') : undefined;
    let didBrowserDisconnect = false;

    const launchOptions = {
        ...defaultPuppeteerBrowserOptions,
        ...args.extraPuppeteerOptions,
        args: [...defaultPuppeteerBrowserOptions.args, ...args.extraChromiumArgs],
        headless: args.headless,
        userDataDir
    };
    if (args.puppeteerExecutablePath) {
        launchOptions['executablePath'] = args.puppeteerExecutablePath;
    }
    try {
        browser = await puppeteer.launch(launchOptions);
        browser.on('disconnected', () => {
            didBrowserDisconnect = true;
        });

        if (didBrowserDisconnect) {
            return chromeCrashed();
        }
        logger.info(`Started Puppeteer with pid ${browser.process().pid}`);
        const page = (await browser.pages())[0];
        output.browser = {
            name: 'Chromium',
            version: await browser.version(),
            user_agent: await browser.userAgent(),
            platform: {
                name: os.type(),
                version: os.release()
            }
        };
        page.emulate(args.emulateDevice);
        if (Object.keys(args.headers).length > 0) {
            page.setExtraHTTPHeaders(args.headers);
        }

        // record all requested hosts
        page.on('request', request => site.recordRequest(request.url()));

        if (args.clearCache) {
            await clearCookiesCache(page);
        }

        // Init blacklight instruments on page
        await setupBlacklightInspector(page, logger.warn);
        await setupKeyLoggingInspector(page, logger.warn);
        await setupHttpCookieCapture(page, logger.warn);
        await setupSessionRecordingInspector(page, logger.warn);
        await setUpThirdPartyTrackersInspector(page, logger.warn, args.enableAdBlock);

        if (args.captureHar) {
            const har = new PuppeteerHar(page);
            await har.start({
                path: args.outDir ? join(args.outDir, 'requests.har') : undefined
            });
            stopHar = () => har.stop();
        }
        if (didBrowserDisconnect) {
            return chromeCrashed();
        }

        const navigation: NavigationOptions = {
            waitUntil: args.defaultWaitUntil as PuppeteerLifeCycleEvent,
            navigationTimeoutMs: args.navigationTimeoutMs,
            defaultTimeout: args.defaultTimeout,
            maxRetries: args.maxRetries,
            deadline
        };

        const landing = await reachLandingPage({ page, inUrl, config: args, navigation, progress });
        if (landing.attempts.length > 0) {
            output.entry_attempts = landing.attempts;
        }
        let harvestedLinks: LinkObject[] = [];
        if (landing.response !== null) {
            const context = { page, config: args, navigation, logger, site, progress, isBrowserConnected: () => !didBrowserDisconnect };
            const crawl = await crawlFromLanding(context, inUrl, landing.response);
            Object.assign(output, crawl.details);
            harvestedLinks = crawl.harvestedLinks;
        }

        if (didBrowserDisconnect) {
            console.log('Browser disconnected; cookies and HAR could not be saved');
        } else {
            await saveBrowserArtifacts(page, args.outDir, stopHar);
        }
        await closeBrowser(browser);
        if (typeof userDataDir !== 'undefined') {
            clearDir(userDataDir, false);
        }

        const links = dedupLinks(harvestedLinks);
        output.end_time = new Date();
        site.classifyLinks(links);
        output.hosts = site.requestHostsReport();
        if (args.captureLinks) {
            output.links = site.links;
            output.social = getSocialLinks(links);
        }

        await new Promise<void>(resolve => {
            logger.on('finish', resolve);
            logger.end();
        });
        return await finalizeResult({ output, config: args, logFilePath, site, progress, landing });
    } finally {
        if (browser && !didBrowserDisconnect) {
            await closeBrowser(browser);
        }
    }
};
