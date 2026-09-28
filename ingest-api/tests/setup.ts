import fs from "fs";

// Runs before any test file (vitest setupFiles), so these are set before the
// app/config modules are imported.
process.env.NODE_ENV = "test";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/ingest-api-unused";
process.env.INGEST_API_KEY ??= "test-api-key";
// Integration tests exercise the real text-mode fallback path. Atlas-mode
// behavior is covered by pipeline unit tests + the gated Atlas e2e suite.
process.env.MONGODB_SEARCH_MODE ??= "text";
process.env.MAX_INGEST_BATCH_SIZE ??= "500";

// Prefer a system mongod for mongodb-memory-server so tests run offline.
if (!process.env.MONGOMS_SYSTEM_BINARY) {
  const candidates = ["/opt/homebrew/bin/mongod", "/usr/bin/mongod", "/usr/local/bin/mongod"];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      process.env.MONGOMS_SYSTEM_BINARY = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
}
