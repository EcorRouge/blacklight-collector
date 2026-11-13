import { PuppeteerLifeCycleEvent, TimeoutError } from 'puppeteer';
import { LoadStopper, NavigablePage, NavigationResponse } from '../../src/pptr-utils/navigate';

/** Fakes and wrappers that let the navigation tests observe goto calls without a real site. */

export interface GotoStats {
    gotoCalls: number;
    inFlight: number;
    maxInFlight: number;
    stops: number;
    timeouts: number[];
    waitUntils: PuppeteerLifeCycleEvent[];
}

export const newStats = (): GotoStats => ({ gotoCalls: 0, inFlight: 0, maxInFlight: 0, stops: 0, timeouts: [], waitUntils: [] });

/** Wraps any page so the tests can observe how many gotos overlap. */
export const tracking = <R extends NavigationResponse>(page: NavigablePage<R>, stats: GotoStats): NavigablePage<R> => ({
    goto: async (url, gotoOptions) => {
        stats.gotoCalls++;
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        stats.timeouts.push(gotoOptions.timeout);
        stats.waitUntils.push(gotoOptions.waitUntil);
        try {
            return await page.goto(url, gotoOptions);
        } finally {
            stats.inFlight--;
        }
    },
    createCDPSession: async () => {
        const session = await page.createCDPSession();
        return {
            send: method => {
                stats.stops++;
                return session.send(method);
            },
            detach: () => session.detach()
        };
    }
});

export const noopSession: LoadStopper = { send: async () => undefined, detach: async () => undefined };

/** A page whose gotos never load and only end by timing out, like a blackholed site. */
export const hangingPage: NavigablePage<NavigationResponse> = {
    goto: (_url, gotoOptions) =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new TimeoutError(`timeout ${gotoOptions.timeout}`)), gotoOptions.timeout)),
    createCDPSession: async () => noopSession
};

export const statusPage = (statuses: number[]): NavigablePage<NavigationResponse> => {
    const queue = [...statuses];
    return {
        goto: async () => {
            const status = queue.shift() ?? 200;
            return { status: () => status };
        },
        createCDPSession: async () => noopSession
    };
};
