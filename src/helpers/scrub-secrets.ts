/**
 * Scan results are stored and shared, but the options that produced them can carry proxy
 * credentials (`--proxy-server=http://user:pass@host:port`). Everything that echoes the
 * configuration back goes through here first so the credentials never leave the process.
 */

const MASK = '***';

/** `scheme://userinfo@` anywhere in a string. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'?#]+@/gi;

/** A whole `--proxy-server=` value, which Chromium also accepts without a scheme or as a per-scheme list. */
const PROXY_FLAG_VALUE = /--proxy-server=[^\s"']*/gi;

/** Userinfo right after the flag, a per-scheme `=` or a list separator, for values without `scheme://`. */
const BARE_USERINFO = /([=;])[^\s"';=@/]+@/g;

export const scrubText = (text: string): string =>
    text
        .replace(PROXY_FLAG_VALUE, flag => flag.replace(BARE_USERINFO, `$1${MASK}@`))
        .replace(URL_USERINFO, `$1${MASK}@`);

/**
 * Deep copy of `value` with every string scrubbed. Non-plain values such as functions are
 * kept by reference: they are not serialised into results and cannot leak through JSON.
 */
export const scrubCredentials = (value: unknown): unknown => {
    if (typeof value === 'string') {
        return scrubText(value);
    }
    if (Array.isArray(value)) {
        return value.map(scrubCredentials);
    }
    if (value instanceof Date || value === null || typeof value !== 'object') {
        return value;
    }
    return Object.entries(value).reduce<Record<string, unknown>>((copy, [key, entry]) => {
        copy[key] = scrubCredentials(entry);
        return copy;
    }, {});
};
