/**
 * A page can navigate on its own (meta refresh, JS redirect, form auto-submit) while we are
 * still harvesting links, filling forms or scrolling. Puppeteer then rejects the in-flight
 * evaluate with "Execution context was destroyed". That says nothing about the rest of the
 * site, so it must not abort the whole crawl.
 */
export const isExecutionContextDestroyed = (error: unknown): boolean =>
    error instanceof Error && error.message.includes('Execution context was destroyed');

/**
 * Runs the per-page interaction work. Returns false when the page navigated away mid-work so
 * the caller can count the page as failed and move on; any other error is re-thrown unchanged.
 */
export const runPageWork = async (url: string, work: () => Promise<void>, log: (message: string) => void = console.log): Promise<boolean> => {
    try {
        await work();
        return true;
    } catch (error) {
        if (!isExecutionContextDestroyed(error)) {
            throw error;
        }
        log(`Page ${url} navigated away while it was being inspected; skipping the rest of its work: ${error.message}`);
        return false;
    }
};
