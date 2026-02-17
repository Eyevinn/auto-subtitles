/**
 * Structured logger for the auto-subtitles service.
 *
 * Outputs JSON-formatted log lines suitable for structured log aggregation
 * (ELK, CloudWatch, Datadog, etc.). Supports log levels, contextual fields,
 * and child loggers for per-request/per-job tracing.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  service: string;
  [key: string]: unknown;
}

class Logger {
  private level: LogLevel;
  private context: Record<string, unknown>;
  private serviceName: string;

  constructor(
    serviceName = 'auto-subtitles',
    level?: LogLevel,
    context?: Record<string, unknown>
  ) {
    this.serviceName = serviceName;
    this.level = level ?? ((process.env.LOG_LEVEL as LogLevel) || 'info');
    this.context = context ?? {};
  }

  /**
   * Create a child logger that inherits the parent's context and adds new fields.
   * Useful for attaching jobId, workerId, requestId, etc.
   */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.serviceName, this.level, {
      ...this.context,
      ...fields
    });
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.log('debug', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.log('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.log('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.log('error', msg, extra);
  }

  private log(
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>
  ): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      ...this.context,
      ...extra
    };

    const line = JSON.stringify(entry);

    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

/** Singleton logger instance for the application */
const logger = new Logger();

export { Logger };
export default logger;
