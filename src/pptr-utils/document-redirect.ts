/**
 * Some parked or moved sites answer 200 and redirect from the document itself. The browser
 * would follow those, so the resolver does too, but only for unambiguous forms: a meta refresh
 * that fires almost immediately, or a one-line assignment to the page location.
 */

/** A refresh slower than this is a page reload or a notice, not a redirect. */
const MAX_REFRESH_DELAY_SECONDS = 5;

const META_TAG = /<meta\b[^>]*>/gi;
const REFRESH_EQUIV = /http-equiv\s*=\s*["']?\s*refresh\b/i;
const CONTENT_ATTR = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const REFRESH_CONTENT = /^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/i;
const LOCATION_ASSIGNMENT = /(?<!\b(?:var|let|const)\s+)(?<![\w$.])(?:(?:window|document|top|self)\.)?location(?:\.href)?\s*=\s*(['"])([^'"\s]+)\1/;
const LOCATION_CALL = /(?<![\w$])(?:(?:window|document|top|self)\.)?location\.(?:replace|assign)\(\s*(['"])([^'"\s]+)\1\s*\)/;

const toAbsolute = (target: string, baseUrl: string): string | null => {
    try {
        const url = new URL(target.trim().replace(/^['"]|['"]$/g, ''), baseUrl);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (error) {
        return null;
    }
};

const findMetaRefresh = (html: string): string | null => {
    for (const tag of html.match(META_TAG) ?? []) {
        if (!REFRESH_EQUIV.test(tag)) {
            continue;
        }
        const content = CONTENT_ATTR.exec(tag);
        const value = content ? content[1] ?? content[2] ?? content[3] : '';
        const parsed = REFRESH_CONTENT.exec(value);
        const delay = parsed && parsed[1] !== undefined ? Number(parsed[1]) : 0;
        const target = parsed ? parsed[2].trim() : '';
        if (target !== '' && delay <= MAX_REFRESH_DELAY_SECONDS) {
            return target;
        }
    }
    return null;
};

const findScriptRedirect = (html: string): string | null => {
    const match = LOCATION_ASSIGNMENT.exec(html) ?? LOCATION_CALL.exec(html);
    return match ? match[2] : null;
};

/** Absolute URL the document redirects to, or null when it does not (or redirects to itself). */
export const findDocumentRedirect = (html: string, baseUrl: string): string | null => {
    const target = findMetaRefresh(html) ?? findScriptRedirect(html);
    const absolute = target === null ? null : toAbsolute(target, baseUrl);
    return absolute !== null && absolute !== new URL(baseUrl).href ? absolute : null;
};
