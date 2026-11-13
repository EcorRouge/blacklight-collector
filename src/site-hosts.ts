import { getDomain, parse } from 'tldts';
import { LinkObject } from './types';

/**
 * First- versus third-party bookkeeping for one scan. A site that moved to another registrable
 * domain owns both, so the final domain is added once the crawl knows where it landed.
 */
export class SiteHosts {
    readonly originalDomain: string | null;
    readonly links: { first_party: LinkObject[]; third_party: LinkObject[] } = { first_party: [], third_party: [] };
    private readonly domains: (string | null)[];
    private readonly requestHosts = { first_party: new Set<string>(), third_party: new Set<string>() };

    constructor(inUrl: string) {
        this.originalDomain = parse(inUrl).domain;
        this.domains = [this.originalDomain];
    }

    isFirstParty(domain: string | null): boolean {
        return this.domains.includes(domain);
    }

    /** Returns true when the domain was not first party before. */
    addFirstPartyDomain(domain: string | null): boolean {
        if (this.isFirstParty(domain)) {
            return false;
        }
        this.domains.push(domain);
        return true;
    }

    /** First-party domains other than the requested one, as the report generators expect them. */
    additionalFirstPartyDomains(): string[] {
        return this.domains.filter((d): d is string => d !== null && d !== this.originalDomain);
    }

    /** Hosts may appear as first and third party depending on the path. */
    recordRequest(url: string): void {
        const l = parse(url);
        if (this.isFirstParty(l.domain)) {
            this.requestHosts.first_party.add(l.hostname);
        } else if (url.indexOf('data://') < 1 && !!l.hostname) {
            this.requestHosts.third_party.add(l.hostname);
        }
    }

    classifyLinks(links: readonly LinkObject[]): void {
        for (const link of links) {
            const l = parse(link.href);
            if (this.isFirstParty(l.domain)) {
                this.links.first_party.push(link);
            } else if (l.hostname && l.hostname !== 'data') {
                this.links.third_party.push(link);
            }
        }
    }

    /** Request hosts; hosts requested before the final domain was known were filed as third party. */
    requestHostsReport() {
        const fpRequests = Array.from(this.requestHosts.first_party);
        const tpRequests = Array.from(this.requestHosts.third_party);
        const incorrectTpAssignment = tpRequests.filter(f => this.isFirstParty(getDomain(f)));
        return {
            requests: {
                first_party: Array.from(new Set(fpRequests.concat(incorrectTpAssignment))),
                third_party: tpRequests.filter(t => !incorrectTpAssignment.includes(t))
            }
        };
    }
}
