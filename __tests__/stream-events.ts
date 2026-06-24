import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { streamEventsByType } from '../src/helpers/stream-events';

const ALL_TESTS = [
  'cookies',
  'key_logging',
  'session_recorders',
  'third_party_trackers',
  'fb_pixel_events',
  'behaviour_event_listeners',
  'canvas_fingerprinters',
  'canvas_font_fingerprinters',
  'fingerprintable_api_calls',
];

const FIXTURE_LINES = [
  JSON.stringify({ message: { type: 'JsInstrument.ObjectProperty', url: 'http://example.com', stack: [], data: { symbol: 'document.cookie', value: 'a=1', operation: 'get' } } }),
  JSON.stringify({ message: { type: 'Cookie.HTTP', url: 'http://example.com', stack: [], data: { name: 'sid', value: 'abc' } } }),
  JSON.stringify({ message: { type: 'KeyLogging', url: 'http://example.com', stack: [], data: { post_request_url: '', post_data: '', match_type: [], filter: [] } } }),
  JSON.stringify({ message: { type: 'SessionRecording', url: 'http://example.com', stack: [], data: {} } }),
  JSON.stringify({ message: { type: 'TrackingRequest', url: 'http://example.com', stack: [], data: {} } }),
  JSON.stringify({ message: { type: 'JsInstrument.Error', url: 'http://example.com', stack: [], data: { symbol: 'err', value: '', operation: '' } } }),
  JSON.stringify({ message: {} }),
  JSON.stringify({ message: { type: null } }),
  'this is not valid json',
  '',
  JSON.stringify({ message: { type: 'JsInstrument.FunctionProxy', url: 'http://example.com', stack: [], data: { symbol: 'document.addEventListener', value: '[]', operation: 'call' } } }),
];

let tmpDir: string;
let fixturePath: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `stream-events-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  fixturePath = join(tmpDir, 'inspection-log.ndjson');
  writeFileSync(fixturePath, FIXTURE_LINES.join('\n'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('streamEventsByType', () => {
  it('routes events to correct buckets', async () => {
    const buckets = await streamEventsByType(fixturePath, ALL_TESTS);

    // 2 JsInstrument variants + 1 Cookie.HTTP
    expect(buckets.cookies.length).toBe(3);
    expect(buckets.cookies.map(e => e.type)).toContain('JsInstrument.ObjectProperty');
    expect(buckets.cookies.map(e => e.type)).toContain('Cookie.HTTP');
    expect(buckets.cookies.map(e => e.type)).toContain('JsInstrument.FunctionProxy');

    expect(buckets.key_logging.length).toBe(1);
    expect(buckets.key_logging[0].type).toBe('KeyLogging');

    expect(buckets.session_recorders.length).toBe(1);
    expect(buckets.session_recorders[0].type).toBe('SessionRecording');

    expect(buckets.third_party_trackers.length).toBe(1);
    expect(buckets.third_party_trackers[0].type).toBe('TrackingRequest');

    expect(buckets.fb_pixel_events.length).toBe(1);
    expect(buckets.fb_pixel_events[0].type).toBe('TrackingRequest');

    // Both JsInstrument variants route to these buckets
    expect(buckets.behaviour_event_listeners.length).toBe(2);
    expect(buckets.canvas_fingerprinters.length).toBe(2);
    expect(buckets.canvas_font_fingerprinters.length).toBe(2);
    expect(buckets.fingerprintable_api_calls.length).toBe(2);
  });

  it('filters out Error types', async () => {
    const buckets = await streamEventsByType(fixturePath, ALL_TESTS);
    const allEvents = Object.values(buckets).flat();
    expect(allEvents.every(e => !e.type.includes('Error'))).toBe(true);
  });

  it('handles only requested tests', async () => {
    const buckets = await streamEventsByType(fixturePath, ['cookies']);

    expect(buckets.cookies.length).toBe(3);
    expect(Object.keys(buckets)).toEqual(['cookies']);
  });

  it('skips malformed and empty lines', async () => {
    const buckets = await streamEventsByType(fixturePath, ALL_TESTS);
    const allEvents = Object.values(buckets).flat();
    expect(allEvents.length).toBeGreaterThan(0);
    allEvents.forEach(e => {
      expect(e.type).toBeDefined();
    });
  });

  it('returns empty buckets for no matching events', async () => {
    const emptyPath = join(tmpDir, 'empty.ndjson');
    writeFileSync(emptyPath, JSON.stringify({ message: { type: 'Cookie.HTTP', url: '', stack: [], data: {} } }));

    const buckets = await streamEventsByType(emptyPath, ['key_logging']);
    expect(buckets.key_logging).toEqual([]);
  });
});
