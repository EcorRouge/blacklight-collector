import { writeFileSync } from 'fs';
import sampleSize from 'lodash.samplesize';
import os from 'os';
import { join } from 'path';
import puppeteer, { Browser, Page, PuppeteerLifeCycleEvent, KnownDevices, PuppeteerLaunchOptions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { getDomain, getSubdomain, parse } from 'tldts';
import { captureBrowserCookies, clearCookiesCache, setupHttpCookieCapture } from './inspectors/cookies';

import { getLogger } from './helpers/logger';
import { generateReport } from './parser';
import { defaultPuppeteerBrowserOptions, savePageContent } from './pptr-utils/default';
import { dedupLinks, getLinks, getSocialLinks } from './pptr-utils/get-links';
import { autoScroll, fillForms } from './pptr-utils/interaction-utils';
import { setupBlacklightInspector } from './inspectors/inspector';
import { setupKeyLoggingInspector } from './inspectors/key-logging';
import { setupSessionRecordingInspector } from './inspectors/session-recording';
import { setUpThirdPartyTrackersInspector } from './inspectors/third-party-trackers';
import { clearDir, closeBrowser } from './helpers/utils';

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
    clearDir(args.outDir);
    const FIRST_PARTY = parse(inUrl);
    let REDIRECTED_FIRST_PARTY = parse(inUrl);
    const logger = getLogger({ outDir: args.outDir, quiet: args.quiet });

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
            if (FIRST_PARTY.domain === l.domain) {
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

        // Function to navigate to a page with a timeout guard
        const navigateWithTimeout = async (page: Page, url: string, timeout: number, waitUntil: PuppeteerLifeCycleEvent, maxRetries: number = 3) => {
            let lastResponse = null;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    page_response = await Promise.race([
                        page.goto(url, {
                            timeout: timeout,
                            waitUntil: waitUntil
                        }),
                        new Promise((_, reject) =>
                            setTimeout(() => {
                                console.log(`Navigation attempt ${attempt} timeout`);
                                reject(new Error(`Navigation attempt ${attempt} timeout`));
                            }, 10000)
                        )
                    ]);
                } catch (error) {
                    console.log(`Attempt ${attempt} failed, trying with domcontentloaded`);
                    try {
                        page_response = await page.goto(url, {
                            timeout: timeout,
                            waitUntil: 'domcontentloaded' as PuppeteerLifeCycleEvent
                        });
                    } catch (fallbackError) {
                        console.log(`Attempt ${attempt} failed completely: ${fallbackError.message}`);
                        if (attempt === maxRetries) {
                            return false;
                        }
                        continue;
                    }
                }
                
                lastResponse = page_response;
                
                // Check if the response status is 2xx (OK)
                if (page_response && page_response.status() >= 200 && page_response.status() < 300) {
                    await savePageContent(pageIndex, args.outDir, page, args.saveScreenshots);
                    return true;
                } else {
                    console.log(`Attempt ${attempt} - HTTP status: ${page_response?.status()} for ${url}`);
                    if (attempt < maxRetries) {
                        console.log(`Retrying navigation to ${url} (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
                    }
                }
            }
            
            console.log(`Skipping page ${url} after ${maxRetries} attempts - final HTTP status: ${lastResponse?.status()}`);
            return false;
        };

        // Go to the first url
        console.log('Going to the first url', inUrl);
        const firstPageSuccess = await navigateWithTimeout(page, inUrl, args.defaultTimeout, args.defaultWaitUntil as PuppeteerLifeCycleEvent);
        
        if (!firstPageSuccess) {
            return {
                status: 'failed',
                page_response: `Initial page returned non-2xx status: ${page_response?.status()}`
            };
        }
        
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
        duplicatedLinks = await getLinks(page);
        REDIRECTED_FIRST_PARTY = parse(output.uri_dest);

        output.uri_dest = page.url();
        duplicatedLinks = await getLinks(page);
        
        // Don't update REDIRECTED_FIRST_PARTY if the redirect is to a completely different domain
        const redirectedDomain = parse(output.uri_dest);
        
        // Check if it's the same root domain (allows subdomain variations)
        const isSameDomain = FIRST_PARTY.domain === redirectedDomain.domain;
        
        console.log("Checking domain redirection:");
        console.log(`Original domain: ${FIRST_PARTY.domain}`);
        console.log(`Redirected domain: ${redirectedDomain.domain}`);
        console.log(`Is same domain: ${isSameDomain}`);
        
        if (!isSameDomain) {
            console.log(`Warning: Site redirected to different domain (${output.uri_dest}). Treating original domain (${inUrl}) as first party.`);
            REDIRECTED_FIRST_PARTY = FIRST_PARTY;
        } else {
            // It's the same domain (possibly different subdomain), so update
            REDIRECTED_FIRST_PARTY = redirectedDomain;
        }

        for (const link of dedupLinks(duplicatedLinks)) {
            const l = parse(link.href);

            if (REDIRECTED_FIRST_PARTY.domain === l.domain) {
                outputLinks.first_party.push(link);
                hosts.links.first_party.add(l.hostname);
            } else {
                if (l.hostname && l.hostname !== 'data') {
                    outputLinks.third_party.push(link);
                    hosts.links.third_party.add(l.hostname);
                }
            }
        }

        await fillForms(page);
        await autoScroll(page);

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
            
            const linkSuccess = await navigateWithTimeout(page, link, args.defaultTimeout, args.defaultWaitUntil as PuppeteerLifeCycleEvent);

            if (linkSuccess) {
                await fillForms(page);

                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second

                duplicatedLinks = duplicatedLinks.concat(await getLinks(page));
                await autoScroll(page);

                pageIndex++;
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

            if (REDIRECTED_FIRST_PARTY.domain === l.domain) {
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
        const incorrectTpAssignment = tpRequests.filter((f: string) => getDomain(f) === REDIRECTED_FIRST_PARTY.domain);
        output.hosts = {
            requests: {
                first_party: fpRequests.concat(incorrectTpAssignment),
                third_party: tpRequests.filter(t => !incorrectTpAssignment.includes(t))
            }
        };

        if (args.captureLinks) {
            output.links = outputLinks;
            output.social = getSocialLinks(links);
        }

        const event_data_all = await new Promise(done => {
            logger.query(
                {
                    start: 0,
                    order: 'desc',
                    limit: Infinity,
                    fields: ['message']
                },
                (err, results) => {
                    if (err) {
                        console.log(`Couldnt load event data ${JSON.stringify(err)}`);
                        return done([]);
                    }

                    return done(results.file);
                }
            );
        });

        if (!Array.isArray(event_data_all)) {
            return {
                status: 'failed',
                page_response: 'Couldnt load event data'
            };
        }
        if (event_data_all.length < 1) {
            return {
                status: 'failed',
                page_response: 'Couldnt load event data'
            };
        }

        // filter only events with type set
        const event_data = event_data_all.filter(event => {
            return !!event.message.type;
        });
        // We only consider something to be a third party tracker if:
        // The domain is different to that of the final url (after any redirection) of the page the user requested to load.
        const reports = args.blTests.reduce((acc, cur) => {
            acc[cur] = generateReport(cur, event_data, args.outDir, REDIRECTED_FIRST_PARTY.domain);
            return acc;
        }, {});

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
