# Blacklight-Collector

**NOTE: This repo contains some, but not all, of the code backing [Blacklight](https://themarkup.org/blacklight). It may not be very useful on its own. We're thinking about ways to move more of the functionality into this package in order to make it more generally useful.**

For more information about the `blacklight-collector` please read our [methodology](https://themarkup.org/blacklight/2020/09/22/how-we-built-a-real-time-privacy-inspector).

`blacklight-collector` is available on npm. You can add it to your own project with the following command.

```
npm i @themarkup/blacklight-collector
```

If you are interested in running it locally you can clone this repository and follow the instructions below.

## Build

`nvm use`

`npm install`

`npm run build`

## Usage

`npm run example`.

Results are stored in `demo-dir` by default

## Collector configuration

`collect` takes the following arguments:

- `inUrl` **required**
  - The URL you want to scrape
- `outDir`
  - default: saves to tmp directory and deletes after completion
  - To save the full report provide a directory path
- `blTests`
  - Array of tests to run
  - default: All
    - "behaviour_event_listeners"
    - "canvas_fingerprinters"
    - "canvas_font_fingerprinters"
    - "cookies"
    - "fb_pixel_events"
    - "key_logging"
    - "session_recorders"
    - "third_party_trackers"
- `numPages`
  - default: 3
  - crawl depth
- `headless`
  - Boolean flag, useful for debugging.
- `emulateDevice`
  - Puppeteer makes device emulation pretty easy. Choose from [this list](https://pptr.dev/#?product=Puppeteer&version=v5.2.1&show=api-puppeteerdevices)
- `captureHar`
  - default: true
  - Boolean flag to save the HTTP requests to a file in the HAR(Http Archive Format).
  - Note: You will need to provide a path to `outDir` if you want to see the captured file
- `captureLinks`
  - default: false
  - Save first and third party links from the pages
- `enableAdBlock`
  - default: false
- `clearCache`
  - default: true
  - Clear the browser cookies and cache
- `saveBrowsingProfile`
  - default: false
  - Lets you optionally save the browsing profile to the `outDir`
- `quiet`
  - default: true
  - dont pipe raw event data to stdout
- `title`
  - default: 'Blacklight Inspection'
- `saveScreenshots`
  - default: true
- `headers`
  - default: `{}` (expects `{ "[HTTP header]": "[value]", ... }`)
- `defaultTimeout`
  - default: 35000
  - upper bound for a single page load; the effective cap is the smallest of `defaultTimeout`, `navigationTimeoutMs` and the time left in `scanTimeoutMs`
- `navigationTimeoutMs`
  - default: 45000
  - cap for one navigation attempt. If loading with `defaultWaitUntil` times out, the pending load is stopped and the page is tried once more with `domcontentloaded`; the two loads never run at the same time
- `scanTimeoutMs`
  - default: 480000
  - total wall-clock budget for the whole crawl, including retries. Once it is spent no further pages are visited; the pages already collected are still reported as a `success` result with `scan_deadline_reached: true` and `partial: true`. If it runs out before any page loads, `collect` returns `{ status: 'failed', page_response: 'Scan time budget exhausted', pages_succeeded: [], pages_failed: [...] }`
- `maxRetries`
  - default: 3
  - attempts per page for network errors and timeouts (never past `scanTimeoutMs`). HTTP errors follow a fixed policy: 400, 401, 404, 405, 410 and 451 are not retried; 403, 429, 5xx and other non-success statuses are retried once after 1 s. 2xx and 304 are success
- `defaultWaitUntil`
  - default: 'networkidle2'
  - [Other options](https://pptr.dev/api/puppeteer.puppeteerlifecycleevent/)
- `puppeteerExecutablePath`
  - default: uses bundled puppeteer chromium
  - Path to Chromium executable.
- `extraChromiumArgs`
  - default: ['--disable-features=TrackingProtection3pcd']
  - Extra flags to pass to Chromium executable
  - A `--proxy-server=http(s)://[user:pass@]host:port` flag is also used for the entry URL pre-resolution and the fallback page discovery requests (below) when the `undici` package is installed; otherwise those requests run without the proxy and log that they did. The proxy URL is never logged, and proxy credentials are replaced with `***` wherever the configuration is echoed back (`config.extraChromiumArgs`, `config.extraPuppeteerOptions`).
- `location`
  - default: nonexistant
  - Optional description of location of scan execution

## Entry URL resolution

Before the browser starts crawling, the requested URL is resolved with a lightweight HTTP client
(HEAD, falling back to GET; up to 10 redirects; one immediate `<meta http-equiv="refresh">` or
one-line `location = '...'` hop in the first 4 KB of HTML; the emulated device's user agent;
at most 8 s per request and 20 s in total, never past `scanTimeoutMs`). The browser then tries these
candidates in order until one returns 2xx/304:

1. the resolved final URL
2. the requested URL
3. the `www.` / apex twin of the final host (only `example.com` <-> `www.example.com`; deeper subdomains such as `api.example.com` are never rewritten or replaced by their parent domain)
4. the `http://` version, only when https failed at the TLS or connection level
5. the origin root `/` of any candidate that pointed to a deeper path

The first candidate gets the usual `maxRetries`; fallbacks get one attempt each, and hosts the browser could not resolve are skipped.

When the site ends up on a different registrable domain, both the requested and the final domain are treated as first party
(request hosts, links and every report).

## Fallback page discovery

When every entry candidate answered with an HTTP error (for example a 403 bot wall or a 404 on an
empty root), the collector looks for another page of the same site to start from. It is skipped when
the candidates failed without any HTTP answer (unresolvable host, connection errors) or the scan
deadline has passed. Sources, in order, each queried only if the previous ones produced no page:

1. links in the body of the error pages (the browser's copy, or a fresh request when the browser no longer has it)
2. sitemaps: the `Sitemap:` entries of `/robots.txt` plus `/sitemap.xml`, following one level of sitemap index; the first 20 page URLs
3. common paths on the origin that answered: `/login`, `/signin`, `/home`, `/index.html`, `/about`, `/contact`

Only pages on the registrable domain of the requested or the resolved URL are used. Each page gets one
navigation; error-page links and sitemap pages are tried at most 3 times each and discovery stops after
8 navigations. Discovery requests read at most 512 KB per response and at most 5 s each (20 s overall),
never past `scanTimeoutMs`. The first page that loads (2xx/304) becomes the landing page and the crawl
continues as usual from its links. Gzipped sitemaps are not read.

## Partial results

A scan reports `status: 'success'` whenever at least one page loaded with 2xx/304, even if other pages
failed. Events recorded on error or bot-wall pages never turn a scan without a loaded page into a success.
`partial: true` marks a result that covers less than was asked for: a sampled page failed, fallback
discovery was needed, or the scan deadline was reached. A site whose pages run no
trackers, set no cookies and register no listeners is a normal `success` with `no_events: true` and
empty reports. Cookies, the HAR and `inspection.json` are saved for every `success`, partial or not.

A scan with no page loaded fails, whatever events were recorded:
`{ status: 'failed', page_response: 'Initial page returned non-2xx status: <status>', entry_attempts, pages_succeeded: [], pages_failed }`.

## Inspection Result

`blacklight-collector` creates a few different assets at the end of an inspection, these include:

- **browser-cookies.json**
  - JSON file containing a list of all the cookies set on that website.
- **inspection-log.ndjson**
  - This file contains all the raw events that are recorded during the inspection which are used for analysis.
  - Every response with `Set-Cookie` headers is recorded as a `Cookie.HTTP` event, including third-party
    responses whose cookies the browser refused to store. The `cookies` report uses these events to label
    each cookie `http`, `js`, `both` or `unknown` by how it was set.
- **inspection.json**:
  - Final inspection report that includes the following keys:
    - `browser`: Details of the browser version used.
    - `browsing_history`: List of pages that were visited.
    - `config`: Inspection configuration.
    - `deviceEmulated`: Information about the device that was emulated for this inspection.
    - `end_time`: When the inspection ended.
    - `host`: The hostname of the visited website.
    - `hosts`: A list of first-party and third-party hosts visited on this inspection.
    - `reports`: The initial results of the tests blacklight runs. For more information please read the [methodology](https://themarkup.org/blacklight/2020/09/22/how-we-built-a-real-time-privacy-inspector).
    - `script`: Details about the NodeJS version, host and this package version.
    - `start_time`: When the inspection began.
    - `uri_ins`: The URL that was entered by the user.
    - `uri_dest`: The final url that was visited after any redirects.
    - `uri_redirects`: The redirect chain.
    - `location`: If passed in as an argument, the description of the scan execution location.
    - `scan_deadline_reached`: Present and `true` when `scanTimeoutMs` ran out before every sampled page was visited.
    - `original_domain`: Registrable domain of `uri_ins`.
    - `final_domain`: Registrable domain of `uri_dest`.
    - `entry_redirected`: `true` when the crawl started on a different hostname than the one requested.
    - `entry_attempts`: Browser navigations made to reach the first page, in order: `[{ url, outcome, source, status?, error? }]` where `outcome` is `success`, `http_status`, `error` or `deadline` and `source` is `candidate` (entry URL resolution), `error_page_link`, `sitemap` or `common_path` (fallback page discovery). A `failed` result carries the same field next to `page_response` whenever at least one navigation was attempted; `page_response` keeps the form `Initial page returned non-2xx status: <last HTTP status of the entry candidates>`.
    - `partial`: `true` when the scan covers fewer pages than requested because pages failed, fallback discovery was needed or the deadline was reached; otherwise `false`. Only present on `success` results.
    - `pages_succeeded`: URLs of the pages that loaded, landing page first.
    - `pages_failed`: Pages that could not be loaded, `[{ url, status?, error? }]`. Entry candidates are listed here only when none of them loaded. Also present on `failed` results.
    - `no_events`: `true` when the inspected pages produced no inspector events; the reports are then empty.
- **n.html**
  - Nth inspected page's html source.
- **n.jpeg**
  - Nth inspected page's screenshot.
- **requests.har**
  - HTTP archive of all the network requests.
  - _TIP:_ Firefox lets you import a HAR file and visualize it using the network tab in the developer tools.
  - You can also view it [here](https://toolbox.googleapps.com/apps/har_analyzer/).

Blacklight would not be possible without the work of [OpenWPM](https://github.com/mozilla/OpenWPM)
and the EU-EDPS's [website evidence collector](https://github.com/EU-EDPS/website-evidence-collector)

### Special Thanks

- [JeffreyHung](https://github.com/Jeffreyhung) for contributions related maintenance and security best-practices
