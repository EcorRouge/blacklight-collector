import os from 'os';
import { join } from 'path';
import { KnownDevices, PuppeteerLaunchOptions, PuppeteerLifeCycleEvent } from 'puppeteer';
import { scrubCredentials } from './helpers/scrub-secrets';

export const DEFAULT_OPTIONS = {
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

export type CollectorOptions = Partial<typeof DEFAULT_OPTIONS> & { location?: string };
export type CollectorConfig = typeof DEFAULT_OPTIONS & { location?: string };

/**
 * The metadata part of a scan result. The configuration is echoed back for reproducibility,
 * with proxy credentials masked because results are stored and shared.
 */
export const buildOutput = (inUrl: string, args: CollectorConfig) => {
    const output: Record<string, any> = {
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
            extraChromiumArgs: scrubCredentials(args.extraChromiumArgs),
            extraPuppeteerOptions: scrubCredentials(args.extraPuppeteerOptions)
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
    if (args.location) {
        output.location = args.location;
    }
    return output;
};
