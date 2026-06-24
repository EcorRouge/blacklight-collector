import path from 'path';
import { setGracefulCleanup, tmpNameSync } from 'tmp';

// https://stackoverflow.com/a/45211015/1407622
import { createLogger, format, transports } from 'winston';

setGracefulCleanup();

export const getLogger = ({ outDir = '', quiet = false }) => {
    const log_transports = [];
    log_transports.push(
        new transports.Console({
            level: 'info',
            silent: quiet
        })
    );

    const filename = outDir ? path.join(outDir, 'inspection-log.ndjson') : tmpNameSync({ postfix: '-log.ndjson' });

    log_transports.push(
        new transports.File({
            filename,
            level: 'silly', // log everything to file
            options: { flags: 'w' } // overwrite instead of append, see https://github.com/winstonjs/winston/issues/1271
        })
    );

    const logger = createLogger({
        // https://stackoverflow.com/a/48573091/1407622
        format: format.combine(format.timestamp(), format.json()),
        transports: log_transports
    });

    return { logger, logFilePath: filename };
};


export const logHeap = (label: string) => {
    const heap = process.memoryUsage();
    console.log(`[${label}] heapUsed=${Math.round(heap.heapUsed / 1024 / 1024)}MB | heapTotal=${Math.round(heap.heapTotal / 1024 / 1024)}MB`);
};
