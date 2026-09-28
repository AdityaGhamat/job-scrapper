import type { Server } from "http";
import { createApp } from "./app";
import { config } from "./config/env";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { Job } from "./modules/jobs/jobs.model";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  await connectDatabase(config.MONGODB_URI);

  // Normal MongoDB indexes only (unique identity, exact filters, fallback
  // text index). The Atlas Search index is managed separately — see
  // search-index/jobs-search-index.json and the README.
  await Job.syncIndexes();
  logger.info("mongodb indexes synced");

  const app = createApp();
  const server: Server = app.listen(config.PORT, () => {
    logger.info("server listening", {
      port: config.PORT,
      env: process.env.NODE_ENV ?? "development",
      searchMode: config.MONGODB_SEARCH_MODE,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutdown signal received", { signal });
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.error("fatal startup error", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
