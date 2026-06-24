import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { BlacklightEvent } from '../types';

const EVENT_TYPE_ROUTING: Record<string, string[]> = {
    'JsInstrument': [
        'cookies',
        'behaviour_event_listeners',
        'canvas_fingerprinters',
        'canvas_font_fingerprinters',
        'fingerprintable_api_calls',
    ],
    'Cookie.HTTP': ['cookies'],
    'KeyLogging': ['key_logging'],
    'SessionRecording': ['session_recorders'],
    'TrackingRequest': ['third_party_trackers', 'fb_pixel_events'],
};

export const streamEventsByType = async (
    logFilePath: string,
    blTests: string[]
): Promise<Record<string, BlacklightEvent[]>> => {
    const buckets: Record<string, BlacklightEvent[]> = {};
    for (const test of blTests) {
        buckets[test] = [];
    }

    const activeTests = new Set(blTests);

    const rl = createInterface({
        input: createReadStream(logFilePath),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;

        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }

        const message = entry?.message;
        if (!message?.type) continue;

        const type: string = message.type;
        if (type.includes('Error')) continue;

        for (const [pattern, reportTypes] of Object.entries(EVENT_TYPE_ROUTING)) {
            if (type.includes(pattern)) {
                for (const reportType of reportTypes) {
                    if (activeTests.has(reportType)) {
                        buckets[reportType].push(message);
                    }
                }
            }
        }
    }

    return buckets;
};
