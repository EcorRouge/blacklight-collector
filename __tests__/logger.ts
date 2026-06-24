import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { getLogger, logHeap } from '../src/helpers/logger';

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `logger-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getLogger', () => {
  it('returns logger and logFilePath', () => {
    const result = getLogger({ outDir: tmpDir, quiet: true });
    expect(result).toHaveProperty('logger');
    expect(result).toHaveProperty('logFilePath');
    expect(result.logFilePath).toMatch(/inspection-log\.ndjson$/);
  });

  it('uses a temp file when outDir is empty', () => {
    const result = getLogger({ outDir: '', quiet: true });
    expect(result.logFilePath).toMatch(/-log\.ndjson$/);
    expect(result.logger).toBeDefined();
  });
});

describe('logHeap', () => {
  it('logs heap usage without throwing', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation();
    expect(() => logHeap('test')).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[test\] heapUsed=\d+MB \| heapTotal=\d+MB/));
    spy.mockRestore();
  });
});
