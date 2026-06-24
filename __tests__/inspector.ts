import puppeteer from 'puppeteer';
import { defaultPuppeteerBrowserOptions } from '../src/pptr-utils/default';
import { setupBlacklightInspector } from '../src/inspectors/inspector';
import { BlacklightEvent, Global } from '../src/types';
declare var global: Global;

jest.setTimeout(30000);

describe('setupBlacklightInspector SKIP_VALUE_SYMBOLS', () => {
  let browser: puppeteer.Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch(defaultPuppeteerBrowserOptions);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('strips value for window.localStorage symbols', async () => {
    const events: BlacklightEvent[] = [];
    const page = await browser.newPage();

    await setupBlacklightInspector(page, event => events.push(event), true);
    await page.goto('about:blank');

    await page.evaluate(() => {
      (window as any).reportEvent(JSON.stringify({
        type: 'JsInstrument.ObjectProperty',
        url: 'http://example.com',
        stack: [],
        data: { symbol: 'window.localStorage', value: 'sensitive-data', operation: 'get' },
      }));
    });

    await page.close();
    const match = events.find(e => (e as any).data?.symbol === 'window.localStorage');
    expect(match).toBeDefined();
    expect((match as any).data.value).toBe('[SKIPPED]');
  });

  it('strips value for window.sessionStorage symbols', async () => {
    const events: BlacklightEvent[] = [];
    const page = await browser.newPage();

    await setupBlacklightInspector(page, event => events.push(event), true);
    await page.goto('about:blank');

    await page.evaluate(() => {
      (window as any).reportEvent(JSON.stringify({
        type: 'JsInstrument.ObjectProperty',
        url: 'http://example.com',
        stack: [],
        data: { symbol: 'window.sessionStorage', value: 'sensitive-data', operation: 'get' },
      }));
    });

    await page.close();
    const match = events.find(e => (e as any).data?.symbol === 'window.sessionStorage');
    expect(match).toBeDefined();
    expect((match as any).data.value).toBe('[SKIPPED]');
  });

  it('preserves value for non-skipped symbols', async () => {
    const events: BlacklightEvent[] = [];
    const page = await browser.newPage();

    await setupBlacklightInspector(page, event => events.push(event), true);
    await page.goto('about:blank');

    await page.evaluate(() => {
      (window as any).reportEvent(JSON.stringify({
        type: 'JsInstrument.ObjectProperty',
        url: 'http://example.com',
        stack: [],
        data: { symbol: 'document.cookie', value: 'a=1; b=2', operation: 'get' },
      }));
    });

    await page.close();
    const match = events.find(e => (e as any).data?.symbol === 'document.cookie');
    expect(match).toBeDefined();
    expect((match as any).data.value).toBe('a=1; b=2');
  });

  it('emits error event for malformed JSON payload', async () => {
    const events: BlacklightEvent[] = [];
    const page = await browser.newPage();

    await setupBlacklightInspector(page, event => events.push(event), true);
    await page.goto('about:blank');

    await page.evaluate(() => {
      (window as any).reportEvent('not-valid-json{{{');
    });

    await page.close();
    const errorEvent = events.find(e => e.type === 'Error.BlacklightInspector');
    expect(errorEvent).toBeDefined();
  });
});
