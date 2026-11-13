import { writeFileSync } from 'fs';
import { join } from 'path';
import { CollectorConfig } from './collector-config';
import { CrawlProgress } from './crawl-progress';
import { logHeap } from './helpers/logger';
import { streamEventsByType } from './helpers/stream-events';
import { clearDir } from './helpers/utils';
import { Landing } from './landing';
import { generateReport } from './parser';
import { SiteHosts } from './site-hosts';
import { BlacklightEvent } from './types';

export interface FinalizeInput {
    output: Record<string, any>;
    config: CollectorConfig;
    logFilePath: string;
    site: SiteHosts;
    progress: CrawlProgress;
    landing: Landing;
}

/**
 * Every requested test gets a report, empty when it saw no events, so consumers can rely on
 * the same report keys for a quiet site as for a busy one.
 */
export const buildReports = (config: CollectorConfig, eventsByType: Record<string, BlacklightEvent[]>, site: SiteHosts) =>
    config.blTests.reduce<Record<string, unknown>>((acc, cur) => {
        acc[cur] = generateReport(cur, eventsByType[cur] || [], config.outDir, site.originalDomain, site.additionalFirstPartyDomains());
        return acc;
    }, {});

/**
 * Turns what the crawl collected into the scan result. A site whose pages simply run no trackers
 * is a valid finding, and a scan that lost pages still says what the pages it did see were doing.
 * Without a single loaded page the scan fails, even if an error or bot-wall page produced events:
 * those describe the wall, not the site.
 */
export const finalizeResult = async ({ output, config, logFilePath, site, progress, landing }: FinalizeInput) => {
    if (landing.response === null) {
        return {
            status: 'failed',
            page_response: landing.failureMessage,
            ...(landing.attempts.length > 0 ? { entry_attempts: landing.attempts } : {}),
            pages_succeeded: [...progress.pagesSucceeded],
            pages_failed: [...progress.pagesFailed]
        };
    }

    console.log('Streaming events by type from log file:', logFilePath);
    logHeap('Before streaming events by type');
    const eventsByType = await streamEventsByType(logFilePath, config.blTests);
    logHeap('After streaming events by type');
    const hasAnyEvents = Object.values(eventsByType).some(arr => arr.length > 0);

    logHeap('Before generating reports');
    const reports = buildReports(config, eventsByType, site);
    logHeap('After generating reports');
    Object.assign(output, progress.summary(), { no_events: !hasAnyEvents });

    writeFileSync(join(config.outDir, 'inspection.json'), JSON.stringify({ ...output, reports }, null, 2));
    if (config.outDir.includes('bl-tmp')) {
        clearDir(config.outDir, false);
    }
    return {
        status: 'success',
        ...output,
        reports
    };
};
