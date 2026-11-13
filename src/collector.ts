import { writeFileSync } from 'fs';
import sampleSize from 'lodash.samplesize';
import os from 'os';
import { join } from 'path';
import puppeteer, { Browser, Page, PuppeteerLifeCycleEvent, KnownDevices, PuppeteerLaunchOptions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { getDomain, getSubdomain, parse } from 'tldts';
import { captureBrowserCookies, clearCookiesCache, setupHttpCookieCapture } from './inspectors/cookies';

import { getLogger, logHeap } from './helpers/logger';
import { streamEventsByType } from './helpers/stream-events';
import { generateReport } from './parser';
import { defaultPuppeteerBrowserOptions, savePageContent } from './pptr-utils/default';
import { dedupLinks, getLinks, getSocialLinks } from './pptr-utils/get-links';
import { autoScroll, fillForms } from './pptr-utils/interaction-utils';
import { setupBlacklightInspector } from './inspectors/inspector';
import { setupKeyLoggingInspector } from './inspectors/key-logging';
import { setupSessionRecordingInspector } from './inspectors/session-recording';
import { setUpThirdPartyTrackersInspector } from './inspectors/third-party-trackers';
import { clearDir, closeBrowser } from './helpers/utils';
import { navigateWithinBudget, NavigationOptions } from './pptr-utils/navigate';
import { runPageWork } from './pptr-utils/page-work';
import { ScanDeadline } from './pptr-utils/scan-deadline';
import { resolveEntryUrl } from './pptr-utils/resolve-entry-url';
import { entryMetadata, lastHttpStatus, openEntryPage } from './pptr-utils/open-entry';

export type CollectorOptions = Partial<typeof DEFAULT_OPTIONS> & {location?: string};

const DEFAULT_OPTIONS = {
    outDir: join(process.cwd(), 'bl-tmp'),
    title: 'Blacklight Inspection',
    emulateDevice: KnownDevices['iPhone 13 Mini'],
    captureHar: true,
    captureLinks: false,
    enableAdBlock: false,
    clearCache: true,
    quiet: true,
    headless: true,
    defaultTimeout: 35000,
    // Total wall-clock budget for the crawl. Callers usually wrap a scan in their own watchdog;
    // stopping here first lets them still get the pages collected so far.
    scanTimeoutMs: 480000,
    // Cap for one navigation attempt, so a single slow page cannot eat the whole budget.
    navigationTimeoutMs: 45000,
    // Attempts per page for network and timeout errors; HTTP statuses use a stricter policy.
    maxRetries: 3,
    numPages: 3,
    defaultWaitUntil: 'networkidle2' as PuppeteerLifeCycleEvent,
    saveBrowserProfile: false,
    saveScreenshots: true,
    headers: {},
    blTests: [
        'behaviour_event_listeners',
        'canvas_fingerprinters',
        'canvas_font_fingerprinters',
        'cookies',
        'fb_pixel_events',
        'key_logging',
        'session_recorders',
        'third_party_trackers'
    ],
    puppeteerExecutablePath: null as string | null,
    extraChromiumArgs: ['--disable-features=TrackingProtection3pcd'] as string[],
    extraPuppeteerOptions: {} as Partial<PuppeteerLaunchOptions>
};

export const collect = async (inUrl: string, args: CollectorOptions) => {
    args = { ...DEFAULT_OPTIONS, ...args };
    const deadline = new ScanDeadline(args.scanTimeoutMs);
    clearDir(args.outDir);
    const FIRST_PARTY = parse(inUrl);
    // A site that moved to another registrable domain owns both; the final one is added on landing.
    const firstPartyDomains: (string | null)[] = [FIRST_PARTY.domain];
    const isFirstPartyDomain = (domain: string | null) => firstPartyDomains.includes(domain);
    const { logger, logFilePath } = getLogger({ outDir: args.outDir, quiet: args.quiet });

    const output: any = {
        title: args.title,
        page_title: '',
        uri_ins: inUrl,
        uri_dest: null,
        uri_redirects: null,
        secure_connection: {},
        host: new URL(inUrl).hostname,
        config: {
            emulateDevice: args.emulateDevice,
            cleareCache: args.clearCache,
            captureHar: args.captureHar,
            captureLinks: args.captureLinks,
            enableAdBlock: args.enableAdBlock,
            saveBrowserProfile: args.saveBrowserProfile,
            numPages: args.numPages,
            defaultTimeout: args.defaultTimeout,
            scanTimeoutMs: args.scanTimeoutMs,
            navigationTimeoutMs: args.navigationTimeoutMs,
            defaultWaitUntil: args.defaultWaitUntil,
            headless: args.headless,
            headers: args.headers,
            extraChromiumArgs: args.extraChromiumArgs,
            extraPuppeteerOptions: args.extraPuppeteerOptions,
        },
        browser: null,
        script: {
            host: os.hostname(),
            version: {
                npm: require('../package.json').version,
                commit: require('../.commit-hash.cjs')
            },
            node_version: process.version
        },
        start_time: new Date(),
        end_time: null
    };
    if (args.location) output.location = args.location;

    // Log network requests and page links
    const hosts = {
        requests: {
            first_party: new Set(),
            third_party: new Set()
        },
        links: {
            first_party: new Set(),
            third_party: new Set()
        }
    };

    let browser: Browser;
    let page: Page;
    let pageIndex = 1;
    let har = {} as any;
    let page_response = null;
    const userDataDir = args.saveBrowserProfile ? join(args.outDir, 'browser-profile') : undefined;
    let didBrowserDisconnect = false;

    const options = {
        ...defaultPuppeteerBrowserOptions,
        ...args.extraPuppeteerOptions,
        args: [...defaultPuppeteerBrowserOptions.args, ...args.extraChromiumArgs],
        headless: args.headless,
        userDataDir
    };
    if (args.puppeteerExecutablePath) {
        options['executablePath'] = args.puppeteerExecutablePath;
    }
    try {
        browser = await puppeteer.launch(options);
        browser.on('disconnected', () => {
            didBrowserDisconnect = true;
        });

        if (didBrowserDisconnect) {
            return {
                status: 'failed',
                page_response: 'Chrome crashed'
            };
        }
        logger.info(`Started Puppeteer with pid ${browser.process().pid}`);
        page = (await browser.pages())[0];
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
        page.on('request', request => {
            const l = parse(request.url());
            // note that hosts may appear as first and third party depending on the path
            if (isFirstPartyDomain(l.domain)) {
                hosts.requests.first_party.add(l.hostname);
            } else {
                if (request.url().indexOf('data://') < 1 && !!l.hostname) {
                    hosts.requests.third_party.add(l.hostname);
                }
            }
        });

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
            har = new PuppeteerHar(page);
            await har.start({
                path: args.outDir ? join(args.outDir, 'requests.har') : undefined
            });
        }
        if (didBrowserDisconnect) {
            return {
                status: 'failed',
                page_response: 'Chrome crashed'
            };
        }

        const navigationOptions: NavigationOptions = {
            waitUntil: args.defaultWaitUntil as PuppeteerLifeCycleEvent,
            navigationTimeoutMs: args.navigationTimeoutMs,
            defaultTimeout: args.defaultTimeout,
            maxRetries: args.maxRetries,
            deadline
        };

        // Go to the first url, falling back to its redirect target and host/scheme variants
        const entry = deadline.isExpired()
            ? { candidates: [inUrl] }
            : await resolveEntryUrl(inUrl, { deadline, userAgent: args.emulateDevice?.userAgent, extraChromiumArgs: args.extraChromiumArgs });
        console.log('Going to the first url', inUrl, 'candidates:', entry.candidates);
        const firstPage = await openEntryPage(page, entry.candidates, navigationOptions);
        const attemptsField = firstPage.attempts.length > 0 ? { entry_attempts: firstPage.attempts } : {};

        if (firstPage.response === null) {
            if (firstPage.deadlineReached || deadline.isExpired()) {
                return {
                    status: 'failed',
                    page_response: 'Scan time budget exhausted',
                    ...attemptsField
                };
            }
            return {
                status: 'failed',
                page_response: `Initial page returned non-2xx status: ${lastHttpStatus(firstPage.attempts)}`,
                ...attemptsField
            };
        }
        page_response = firstPage.response;
        output.entry_attempts = firstPage.attempts;
        await savePageContent(pageIndex, args.outDir, page, args.saveScreenshots);

        // Save landing page title
        const title = await page.title();
        output.page_title = title;

        pageIndex++;
        console.log('Saving first page response');

        let duplicatedLinks = [];
        const outputLinks = {
            first_party: [],
            third_party: []
        };

        output.uri_redirects = page_response
            .request()
            .redirectChain()
            .map(req => {
                return req.url();
            });

        output.uri_dest = page.url();
        Object.assign(output, entryMetadata(inUrl, output.uri_dest));
        if (!isFirstPartyDomain(output.final_domain)) {
            firstPartyDomains.push(output.final_domain);
            console.log(`Site moved from ${FIRST_PARTY.domain} to ${output.final_domain}; treating both as first party.`);
        }
        // If the landing page navigates away while we read it, keep crawling with what we have.
        await runPageWork(inUrl, async () => {
            duplicatedLinks = await getLinks(page);
        });

        for (const link of dedupLinks(duplicatedLinks)) {
            const l = parse(link.href);

            if (isFirstPartyDomain(l.domain)) {
                outputLinks.first_party.push(link);
                hosts.links.first_party.add(l.hostname);
            } else {
                if (l.hostname && l.hostname !== 'data') {
                    outputLinks.third_party.push(link);
                    hosts.links.third_party.add(l.hostname);
                }
            }
        }

        await runPageWork(inUrl, async () => {
            await fillForms(page);
            await autoScroll(page);
        });

        let subDomainLinks = [];
        if (getSubdomain(output.uri_dest) !== 'www') {
            subDomainLinks = outputLinks.first_party.filter(f => {
                return getSubdomain(f.href) === getSubdomain(output.uri_dest);
            });
        } else {
            subDomainLinks = outputLinks.first_party;
        }
        const browse_links = sampleSize(subDomainLinks, args.numPages);
        output.browsing_history = [output.uri_dest].concat(browse_links.map(l => l.href));
        console.log(`About to browse ${browse_links?.length} more links`);

        let successUrls = 0;
        let failedUrls = 0;

        for (const [idx, link] of output.browsing_history.slice(1).entries()) {
            // Out of time: stop browsing but still produce a normal report from the pages we have.
            if (deadline.isExpired()) {
                console.log(`Scan time budget exhausted, skipping remaining ${output.browsing_history.length - 1 - idx} links`);
                output.scan_deadline_reached = true;
                break;
            }
            logger.log('info', `[#${idx + 2}] browsing now to ${link}`, { type: 'Browser' });
            if (didBrowserDisconnect) {
                return {
                    status: 'failed',
                    page_response: 'Chrome crashed'
                };
            }
            if (args.clearCache) {
                await clearCookiesCache(page);
            }
            console.log(`[#${idx + 2}] Browsing now to ${link}`);

            const linkOutcome = await navigateWithinBudget(page, link, navigationOptions);
            if (linkOutcome.kind !== 'success') {
                failedUrls++;
                if (linkOutcome.kind === 'deadline') {
                    console.log(`Scan time budget exhausted while loading ${link}`);
                    output.scan_deadline_reached = true;
                    break;
                }
                continue;
            }

            await savePageContent(pageIndex, args.outDir, page, args.saveScreenshots);
            pageIndex++;
            const harvested = await runPageWork(link, async () => {
                await fillForms(page);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second
                duplicatedLinks = duplicatedLinks.concat(await getLinks(page));
                await autoScroll(page);
            });
            if (harvested) {
                successUrls++;
            } else {
                failedUrls++;
            }
        }

        console.log(`Finished browsing website. ${successUrls} pages browsed successfully, ${failedUrls} failed.`);

        await captureBrowserCookies(page, args.outDir);
        if (args.captureHar) {
            await har.stop();
        }

        await closeBrowser(browser);
        if (typeof userDataDir !== 'undefined') {
            clearDir(userDataDir, false);
        }

        const links = dedupLinks(duplicatedLinks);
        output.end_time = new Date();
        for (const link of links) {
            const l = parse(link.href);

            if (isFirstPartyDomain(l.domain)) {
                outputLinks.first_party.push(link);
                hosts.links.first_party.add(l.hostname);
            } else {
                if (l.hostname && l.hostname !== 'data') {
                    outputLinks.third_party.push(link);
                    hosts.links.third_party.add(l.hostname);
                }
            }
        }

        // generate report
        const fpRequests = Array.from(hosts.requests.first_party);
        const tpRequests = Array.from(hosts.requests.third_party);
        // Hosts requested before the final domain was known were filed as third party.
        const incorrectTpAssignment = tpRequests.filter((f: string) => isFirstPartyDomain(getDomain(f)));
        output.hosts = {
            requests: {
                first_party: Array.from(new Set(fpRequests.concat(incorrectTpAssignment))),
                third_party: tpRequests.filter(t => !incorrectTpAssignment.includes(t))
            }
        };

        if (args.captureLinks) {
            output.links = outputLinks;
            output.social = getSocialLinks(links);
        }


        await new Promise<void>((resolve) => {
            logger.on('finish', resolve);
            logger.end();
        });

        console.log("Streaming events by type from log file:", logFilePath);
        logHeap("Before streaming events by type");
        const eventsByType = await streamEventsByType(logFilePath, args.blTests);
        logHeap("After streaming events by type");
        console.log("Finished streaming events by type.")

        const hasAnyEvents = Object.values(eventsByType).some(arr => arr.length > 0);
        if (!hasAnyEvents) {
            return {
                status: 'failed',
                page_response: 'Couldnt load event data'
            };
        }

        // We only consider something to be a third party tracker if:
        // The domain is different to both the requested url's domain and the final url's (after any redirection).
        logHeap("Before generating reports");
        const additionalFirstPartyDomains = firstPartyDomains.filter((d): d is string => d !== null && d !== FIRST_PARTY.domain);
        const reports = args.blTests.reduce((acc, cur) => {
            acc[cur] = generateReport(cur, eventsByType[cur] || [], args.outDir, FIRST_PARTY.domain, additionalFirstPartyDomains);
            return acc;
        }, {});
        logHeap("After generating reports");

        const json_dump = JSON.stringify({ ...output, reports }, null, 2);
        writeFileSync(join(args.outDir, 'inspection.json'), json_dump);
        if (args.outDir.includes('bl-tmp')) {
            clearDir(args.outDir, false);
        }
        return { 
            status: 'success', 
            ...output, 
            reports,
        };
    } finally {
        if (browser && !didBrowserDisconnect) {
            await closeBrowser(browser);
        }
    }
};
