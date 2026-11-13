import { ResolutionFailureKind } from './entry-candidates';

/** Low-level pieces of the entry resolver: the fetch surface it uses and how failures are classified. */

/** The parts of a fetch Response the resolver reads. */
export interface ResponseLike {
    status: number;
    /** Final URL after redirects, when the client followed them. */
    url?: string;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
}

export interface FetchInit {
    method: 'HEAD' | 'GET';
    headers: Record<string, string>;
    redirect: 'manual' | 'follow';
    signal: AbortSignal;
    dispatcher?: object;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

const DOCUMENT_SNIFF_BYTES = 4096;
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|EPROTO$|ERR_OSSL_)/;
const CONNECTION_CODES: ReadonlySet<string> = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);

export class RequestFailure extends Error {
    constructor(readonly kind: ResolutionFailureKind, message: string) {
        super(message);
    }
}

const errorCode = (error: unknown): string => {
    // undici reports the socket-level reason on `cause`; Error.cause is not in this lib target.
    const cause: unknown = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
    for (const candidate of [cause, error]) {
        if (typeof candidate === 'object' && candidate !== null && 'code' in candidate && typeof candidate.code === 'string') {
            return candidate.code;
        }
    }
    return '';
};

export const classifyError = (error: unknown, timedOut: boolean): RequestFailure => {
    const code = errorCode(error);
    const message = error instanceof Error ? `${error.message}${code ? ` (${code})` : ''}` : String(error);
    if (timedOut) {
        return new RequestFailure('timeout', 'request timed out');
    }
    if (TLS_CODE.test(code)) {
        return new RequestFailure('tls', message);
    }
    if (CONNECTION_CODES.has(code)) {
        return new RequestFailure('connection', message);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new RequestFailure('dns', message);
    }
    return new RequestFailure('other', message);
};

export const readHead = async (body: ReadableStream<Uint8Array>, limit = DOCUMENT_SNIFF_BYTES): Promise<string> => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (size < limit) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            size += value.length;
        }
    } finally {
        // Only the start of the body matters; do not download the rest.
        await reader.cancel();
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, limit);
};

export const isHtml = (response: ResponseLike): boolean => {
    const type = response.headers.get('content-type');
    return type === null || type.toLowerCase().includes('html');
};
