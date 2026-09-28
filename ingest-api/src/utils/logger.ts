type LogMeta = Record<string, unknown>;

function format(level: string, message: string, meta?: LogMeta): string {
  const base: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (meta && Object.keys(meta).length > 0) base.meta = meta;
  return JSON.stringify(base);
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    console.log(format("info", message, meta));
  },
  warn(message: string, meta?: LogMeta): void {
    console.warn(format("warn", message, meta));
  },
  error(message: string, meta?: LogMeta): void {
    console.error(format("error", message, meta));
  },
  debug(message: string, meta?: LogMeta): void {
    if (process.env.NODE_ENV !== "production") {
      console.log(format("debug", message, meta));
    }
  },
};
