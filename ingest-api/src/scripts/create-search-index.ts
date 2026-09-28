/**
 * Optional Atlas Search index bootstrap.
 *
 * Usage:
 *   npm run create-search-index            # create/update from search-index/jobs-search-index.json
 *   npm run create-search-index:dry-run    # print the definition + manual steps only
 *
 * The driver call works against Atlas clusters that support Search index
 * management. If it fails (self-managed MongoDB, permissions, older Atlas
 * tier), this script prints the exact manual steps instead of failing silently.
 */
import fs from "fs";
import path from "path";
import { config } from "../config/env";
import { connectDatabase, disconnectDatabase } from "../config/database";
import { Job } from "../modules/jobs/jobs.model";
import { logger } from "../utils/logger";

export const DEFINITION_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "search-index",
  "jobs-search-index.json",
);

export function loadDefinition(): { name: string; definition: Record<string, unknown> } {
  const raw = fs.readFileSync(DEFINITION_PATH, "utf8");
  const parsed = JSON.parse(raw) as { name?: string; definition?: Record<string, unknown> };
  if (!parsed.name || !parsed.definition) {
    throw new Error(`${DEFINITION_PATH} must contain { name, definition }`);
  }
  return { name: parsed.name, definition: parsed.definition };
}

function printManualSteps(name: string, definition: Record<string, unknown>): void {
  console.log("\nManual Atlas Search index setup");
  console.log("================================");
  console.log(`1. Open your Atlas cluster -> "Search Indexes" -> "Create Search Index".`);
  console.log(`2. Choose the JSON editor.`);
  console.log(`3. Set the index name to: ${name}`);
  console.log(`4. Set the database/collection to the jobs collection used by MONGODB_URI.`);
  console.log(`5. Paste this definition (from search-index/jobs-search-index.json):\n`);
  console.log(JSON.stringify(definition, null, 2));
  console.log(`\n6. Create the index and wait for status READY.`);
  console.log(
    `Alternatively with atlasCLI: atlas clusters search indexes create --clusterName <cluster> --db <db> --collection jobs --indexName ${name} --file search-index/jobs-search-index.json\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const { name, definition } = loadDefinition();

  if (dryRun) {
    console.log(`Index name: ${name}`);
    printManualSteps(name, definition);
    return;
  }

  logger.info("creating Atlas Search index", { index: name });
  await connectDatabase(config.MONGODB_URI);
  try {
    const collection = Job.collection;
    if (typeof collection.createSearchIndex !== "function") {
      logger.warn("driver does not support createSearchIndex; printing manual steps");
      printManualSteps(name, definition);
      process.exitCode = 1;
      return;
    }
    const createdName = await collection.createSearchIndex({ name, definition });
    logger.info("Atlas Search index creation accepted", { index: createdName });
    console.log(
      `Index "${createdName}" creation accepted. It becomes usable once Atlas reports it READY.`,
    );
  } catch (err) {
    logger.error("createSearchIndex failed; follow the manual steps below", {
      message: err instanceof Error ? err.message : String(err),
    });
    printManualSteps(name, definition);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly = process.argv[1]?.includes("create-search-index") ?? false;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    logger.error("fatal error", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
