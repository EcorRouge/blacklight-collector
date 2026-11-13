import sampleSize from 'lodash.samplesize';
import { HTTPResponse, Page } from 'puppeteer';
import { getSubdomain } from 'tldts';
import { Logger } from 'winston';
import { CollectorConfig } from './collector-config';
import { CrawlProgress } from './crawl-progress';
import { clearCookiesCache } from './inspectors/cookies';
import { savePageContent } from './pptr-utils/default';
import { dedupLinks, getLinks } from './pptr-utils/get-links';
import { autoScroll, fillForms } from './pptr-utils/interaction-utils';
import { navigateWithinBudget, NavigationOptions } from './pptr-utils/navigate';
import { attemptFromOutcome, entryMetadata } from './pptr-utils/open-entry';
import { runPageWork } from './pptr-utils/page-work';
import { SiteHosts } from './site-hosts';
import { LinkObject } from './types';

export interface CrawlContext {
    page: Page;
    config: CollectorConfig;
    navigation: NavigationOptions;
    logger: Logger;
    site: SiteHosts;
    progress: CrawlProgress;
    isBrowserConnected: () => boolean;
}

export interface CrawlResult {
    /** Result fields describing the landing page and the pages browsed. */
    details: Record<string, unknown>;
    /** Every link harvested, duplicates included. */
    harvestedLinks: LinkObject[];
}

/**
 * Inspects the landing page, then up to numPages same-site links sampled from it. Pages that
 * fail are recorded and skipped; running out of time ends the crawl with what was collected.
 */
export const crawlFromLanding = async (ctx: CrawlContext, inUrl: string, response: HTTPResponse): Promise<CrawlResult> => {
    const { page, config, site, progress, navigation } = ctx;
    let pageIndex = 1;
    await savePageContent(pageIndex++, config.outDir, page, config.saveScreenshots);
    const pageTitle = await page.title();
    const uriDest = page.url();
    const entry = entryMetadata(inUrl, uriDest);
    const details: Record<string, unknown> = {
        page_title: pageTitle,
        uri_redirects: response.request().redirectChain().map(req => req.url()),
        uri_dest: uriDest,
        ...entry
    };
    if (site.addFirstPartyDomain(entry.final_domain)) {
        console.log(`Site moved from ${site.originalDomain} to ${entry.final_domain}; treating both as first party.`);
    }
    progress.succeeded(uriDest);

    let harvestedLinks: LinkObject[] = [];
    // If the landing page navigates away while we read it, keep crawling with what we have.
    await runPageWork(inUrl, async () => {
        harvestedLinks = await getLinks(page);
    });
    site.classifyLinks(dedupLinks(harvestedLinks));
    await runPageWork(inUrl, async () => {
        await fillForms(page);
        await autoScroll(page);
    });

    const subDomainLinks = getSubdomain(uriDest) !== 'www'
        ? site.links.first_party.filter(f => getSubdomain(f.href) === getSubdomain(uriDest))
        : site.links.first_party;
    const browseLinks: string[] = sampleSize(subDomainLinks, config.numPages).map(l => l.href);
    details.browsing_history = [uriDest].concat(browseLinks);
    console.log(`About to browse ${browseLinks.length} more links`);

    let inspected = 0;
    for (const [idx, link] of browseLinks.entries()) {
        // Out of time: stop browsing but still produce a normal report from the pages we have.
        if (navigation.deadline.isExpired()) {
            console.log(`Scan time budget exhausted, skipping remaining ${browseLinks.length - idx} links`);
            details.scan_deadline_reached = true;
            progress.markIncomplete();
            break;
        }
        if (!ctx.isBrowserConnected()) {
            console.log(`Browser disconnected, skipping remaining ${browseLinks.length - idx} links`);
            progress.failed({ url: link, error: 'Browser disconnected' });
            break;
        }
        ctx.logger.log('info', `[#${idx + 2}] browsing now to ${link}`, { type: 'Browser' });
        if (config.clearCache) {
            await clearCookiesCache(page);
        }
        console.log(`[#${idx + 2}] Browsing now to ${link}`);

        const outcome = await navigateWithinBudget(page, link, navigation);
        if (outcome.kind !== 'success') {
            progress.failedAttempts([attemptFromOutcome(link, outcome)]);
            if (outcome.kind === 'deadline') {
                console.log(`Scan time budget exhausted while loading ${link}`);
                details.scan_deadline_reached = true;
                break;
            }
            continue;
        }

        await savePageContent(pageIndex++, config.outDir, page, config.saveScreenshots);
        progress.succeeded(link);
        const completed = await runPageWork(link, async () => {
            await fillForms(page);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second
            harvestedLinks = harvestedLinks.concat(await getLinks(page));
            await autoScroll(page);
        });
        inspected += completed ? 1 : 0;
    }

    console.log(`Finished browsing website. ${inspected} of ${browseLinks.length} more pages fully inspected.`);
    return { details, harvestedLinks };
};
