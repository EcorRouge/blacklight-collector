import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scrubCredentials, scrubText } from '../src/helpers/scrub-secrets';
import { generateReport } from '../src/parser';

describe('scrubbing proxy credentials', () => {
    it('masks proxy userinfo in every flag form and nested option', () => {
        expect(scrubText('--proxy-server=http://user:pa55@proxy.example:8080')).toBe('--proxy-server=http://***@proxy.example:8080');
        expect(scrubText('--proxy-server=user:pa55@proxy.example:8080')).toBe('--proxy-server=***@proxy.example:8080');
        expect(scrubText('--proxy-server=http=u:p@a:1;https=v:q@b:2')).toBe('--proxy-server=http=***@a:1;https=***@b:2');
        expect(scrubCredentials({ protocolTimeout: 180000, env: { HTTPS_PROXY: 'https://u:p@proxy:1' }, args: ['--x'] })).toEqual({
            protocolTimeout: 180000,
            env: { HTTPS_PROXY: 'https://***@proxy:1' },
            args: ['--x']
        });
    });
});

describe('reports without events', () => {
    let emptyDir: string;

    beforeAll(() => {
        emptyDir = mkdtempSync(join(tmpdir(), 'bl-empty-'));
    });
    afterAll(() => {
        rmSync(emptyDir, { recursive: true, force: true });
    });

    it('generateReport accepts no events for every test', () => {
        const tests = [
            'behaviour_event_listeners', 'canvas_fingerprinters', 'canvas_font_fingerprinters', 'cookies',
            'fb_pixel_events', 'fingerprintable_api_calls', 'key_logging', 'session_recorders', 'third_party_trackers'
        ];
        const reports = tests.map(test => generateReport(test, [], emptyDir, 'site.example'));

        expect(reports).toEqual([
            {}, { data_url: {}, fingerprinters: [], styles: {}, texts: {} }, { canvas_font: {}, text_measure: {} }, [], [], {}, {}, {}, []
        ]);
    });
});
