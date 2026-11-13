import { existsSync, readFileSync, writeFileSync } from 'fs';
import flatten from 'lodash.flatten';
import { join } from 'path';
import { HTTPResponse, Page } from 'puppeteer';
import { getDomain, getHostname } from 'tldts';
import { Cookie, defaultPath } from 'tough-cookie';
import { getScriptUrl, hasOwnProperty } from '../helpers/utils';

const parseCookie = (cookieStr: string, url: string) => {
    const cookie = Cookie.parse(cookieStr);
    try {
        if (typeof cookie !== 'undefined') {
            if (!cookie.domain) {
                // A cookie without a Domain attribute belongs to the host that set it.
                // https://stackoverflow.com/a/5258477/1407622
                cookie.domain = getHostname(url);
            }
            return cookie;
        } else {
            return false;
        }
    } catch (error) {
        return false;
    }
};

/**
 * Without a Path attribute the browser scopes the cookie to the directory of the setting URL
 * (RFC 6265 5.1.4). Left unset, the third-party check glues the missing path onto the domain
 * ("cnn.comundefined") and calls every such cookie third party.
 */
const parseHeaderCookie = (cookieStr: string, url: string) => {
    const cookie = parseCookie(cookieStr, url);
    if (cookie && !cookie.path) {
        cookie.path = defaultPath(new URL(url).pathname);
    }
    return cookie;
};

/**
 * The page the cookie was set on. While a document response is arriving its frame still shows the
 * previous URL (about:blank on the first visit), so a top-level navigation is the page itself.
 * Requests issued by the browser or a service worker have no frame.
 */
const visitedPageUrl = (page: Page, response: HTTPResponse) => {
    const request = response.request();
    const frame = request.frame();
    if (frame === null) {
        return page.url();
    }
    if (request.isNavigationRequest() && frame === page.mainFrame()) {
        return response.url();
    }
    let top = frame;
    while (top.parentFrame()) {
        top = top.parentFrame();
    }
    return top.url();
};

/**
 * Puppeteer 22 builds `headers()` from the raw CDP ExtraInfo headers whenever Chrome sends them, so
 * Set-Cookie is present for first- and third-party responses, redirects included, even when Chrome
 * then refuses to store the cookie. Repeated Set-Cookie headers arrive joined with '\n'.
 */
export const setupHttpCookieCapture = async (page: Page, eventHandler: (event: unknown) => void) => {
    page.on('response', (response: HTTPResponse) => {
        const requestUrl = response.url();
        try {
            const cookieHTTP = response.headers()['set-cookie'];
            if (!cookieHTTP) {
                return;
            }
            const stack = [
                {
                    fileName: requestUrl,
                    source: `set in Set-Cookie HTTP response header for ${requestUrl}`
                }
            ];
            const data = cookieHTTP
                .split('\n')
                .filter(c => c.trim())
                .map(c => parseHeaderCookie(c, requestUrl));
            eventHandler({
                data,
                raw: cookieHTTP,
                stack,
                type: 'Cookie.HTTP',
                url: visitedPageUrl(page, response)
            });
        } catch (error) {
            console.log(`Could not record the Set-Cookie header of ${requestUrl}: ${error.message}`);
        }
    });
};

export const clearCookiesCache = async (page: Page) => {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    await client.detach();
};

const getHTTPCookies = (events, url): any[] => {
    return flatten(
        events
            .filter(event => event.type && event.type.includes('Cookie.HTTP'))
            .map(event =>
                event.data
                    .filter(c => c)
                    .map(data => ({
                        domain: hasOwnProperty(data, 'domain') ? data.domain : getHostname(url),
                        name: data.key,
                        path: data.path,
                        script: getScriptUrl(event),
                        type: 'Cookie.HTTP',
                        value: data.value
                    }))
            )
    );
};

export const getJsCookies = (events, url) => {
    return events
        .filter(
            event =>
                event.type &&
                event.type.includes('JsInstrument.ObjectProperty') &&
                event.data.symbol.includes('cookie') &&
                event.data.operation.startsWith('set') &&
                typeof event.data.value !== 'undefined' &&
                typeof Cookie.parse(event.data.value) !== 'undefined'
        )
        .map(event => {
            const data         = parseCookie(event.data.value, url);
            const hasOwnDomain = hasOwnProperty(event, 'domain') && 
                                 event.domain !== null && 
                                 event.domain !== undefined;
            const hasOwnName   = data && 
                                 hasOwnProperty(data, 'key') && 
                                 data.key !== null && 
                                 data.key !== undefined;
            const hasOwnPath   = data && 
                                 hasOwnProperty(data, 'path') && 
                                 data.path !== null && 
                                 data.path !== undefined;
            const hasOwnValue  = data && 
                                 hasOwnProperty(data, 'value') && 
                                 data.value !== null && 
                                 data.value !== undefined;
            const script       = getScriptUrl(event);

            return {
                domain: hasOwnDomain ? event.domain : getDomain(url),
                name: hasOwnName ? data.key : '',
                path: hasOwnPath ? data.path : '',
                script,
                type: event.type,
                value: hasOwnValue ? data.value : ''
            };
        });
};

export const matchCookiesToEvents = (cookies, events, url, additionalFirstPartyDomains: readonly string[] = []) => {
    const isThirdParty = (cookieDomain: string | null) => getDomain(url) !== cookieDomain && !additionalFirstPartyDomains.includes(cookieDomain);
    const jsCookies = getJsCookies(events, url);
    const httpCookie = getHTTPCookies(events, url);

    if (cookies.length < 1) {
        const js = jsCookies
            .map(jsCookie => ({
                ...jsCookie,
                third_party: isThirdParty(getDomain(`cookie://${jsCookie.domain}${jsCookie.path}`)),
                type: 'js'
            }))
            .filter(
                (thing, index, self) =>
                    index === self.findIndex(
                        t => t.name === thing.name && t.domain === thing.domain
                    )
            );
        const http = httpCookie
            .map(httpCookie => ({
                ...httpCookie,
                third_party: isThirdParty(getDomain(`cookie://${httpCookie.domain}${httpCookie.path}`)),
                type: 'http'
            }))
            .filter(
                (thing, index, self) => 
                    index === self.findIndex(
                        t => t.name === thing.name && t.domain === thing.domain && t.value === thing.value
                    )
            );
        return [...js, ...http];
    }
    const final = cookies.map(cookie => {
        const isHttpCookie = httpCookie.find((c: any) => cookie.name === c.name && cookie.domain === c.domain && cookie.value === c.value);
        const isJsCookie = jsCookies.find((c: any) => cookie.name === c.name && cookie.domain === c.domain && cookie.value === c.value);

        let type = '';
        if (typeof isHttpCookie !== 'undefined' && typeof isJsCookie !== 'undefined') {
            type = 'both';
        } else if (typeof isHttpCookie !== 'undefined') {
            type = 'http';
        } else if (typeof isJsCookie !== 'undefined') {
            type = 'js';
        } else {
            type = 'unknown';
        }

        const third_party = isThirdParty(getDomain(`cookie://${cookie.domain}${cookie.path}`));
        return { ...cookie, type, third_party };
    });
    return final.sort((a, b) => b.expires - a.expires);
};

// NOTE: There is a bug in chrome that prevents us from catching all the cookies being set using its instrumentation
// https://blog.ermer.de/2018/06/11/chrome-67-provisional-headers-are-shown/
// The following call using the dev tools protocol ensures we get all the cookies even if we cant trace the source for each call
export const captureBrowserCookies = async (page, outDir, filename = 'browser-cookies.json') => {
    const client = await page.target().createCDPSession();
    const browser_cookies = (await client.send('Network.getAllCookies')).cookies.map(cookie => {
        if (cookie.expires > -1) {
            // add derived attributes for convenience
            cookie.expires = new Date(cookie.expires * 1000);
        }
        cookie.domain = cookie.domain.replace(/^\./, ''); // normalise domain value
        return cookie;
    });
    await client.detach();
    try {
        writeFileSync(join(outDir, filename), JSON.stringify({ browser_cookies }, null, 2));
    } catch (error) {
        console.log(error);
        console.log('Couldnt save browser cookies to file');
    }
    return browser_cookies;
};

export const loadBrowserCookies = (dataDir, filename = 'browser-cookies.json') => {
    try {
        if (existsSync(join(dataDir, filename))) {
            const cookies = JSON.parse(readFileSync(join(dataDir, filename), 'utf-8'));
            return cookies.browser_cookies || [];
        } else {
            return [];
        }
    } catch (error) {
        console.log('Couldnt load browser cookies');
        console.log(error);
        return [];
    }
};
