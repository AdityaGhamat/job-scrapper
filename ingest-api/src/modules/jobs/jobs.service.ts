import type { AnyBulkWriteOperation } from "mongoose";
import { logger } from "../../utils/logger";
import { Job, type JobDocument } from "./jobs.model";
import type {
  IngestResponseBody,
  NormalizedJob,
  ScraperJobInput,
} from "./jobs.types";

/**
 * Best-effort date parsing. Returns null for empty/invalid input so a bad
 * date never invalidates an otherwise valid job.
 */
export function parseUpdatedDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const time = Date.parse(trimmed);
    return Number.isNaN(time) ? null : new Date(time);
  }
  return null;
}

export function normalizeJob(input: ScraperJobInput, scrapedAt: Date): NormalizedJob {
  const department = (input.Department ?? "").trim();
  return {
    company: input.Company.trim(),
    title: input.Title.trim(),
    location: (input.Location ?? "").trim(),
    department: department === "" ? null : department,
    url: input.URL.trim(),
    updated: parseUpdatedDate(input.Updated),
    source: input.Source,
    scrapedAt,
  };
}

function identityKey(job: NormalizedJob): string {
  return `${job.source}\n${job.url}`;
}

/**
 * Deduplicate one batch by (source, url). Last occurrence wins so a batch
 * that repeats a job carries the latest values forward.
 */
export function dedupeJobsBySourceUrl(jobs: NormalizedJob[]): NormalizedJob[] {
  const byKey = new Map<string, NormalizedJob>();
  for (const job of jobs) byKey.set(identityKey(job), job);
  return [...byKey.values()];
}

export async function ingestJobs(
  runId: string,
  jobs: ScraperJobInput[],
): Promise<IngestResponseBody> {
  const startedAt = Date.now();
  const scrapedAt = new Date();

  const unique = dedupeJobsBySourceUrl(jobs.map((job) => normalizeJob(job, scrapedAt)));

  let inserted = 0;
  let updated = 0;
  if (unique.length > 0) {
    const ops: AnyBulkWriteOperation<JobDocument>[] = unique.map((job) => ({
      updateOne: {
        filter: { source: job.source, url: job.url },
        update: {
          $set: {
            company: job.company,
            title: job.title,
            location: job.location,
            department: job.department,
            updated: job.updated,
            scrapedAt: job.scrapedAt,
            updatedAt: job.scrapedAt,
          },
          // source/url also come from the equality filter on upsert; setting
          // them explicitly makes the insert document self-describing.
          $setOnInsert: {
            source: job.source,
            url: job.url,
            createdAt: job.scrapedAt,
          },
        },
        upsert: true,
      },
    }));

    // Single round-trip, unordered: one bad op never blocks the rest of the batch.
    const result = await Job.bulkWrite(ops, { ordered: false, timestamps: false });
    inserted = result.upsertedCount ?? 0;
    // modifiedCount counts docs whose stored values actually changed. A retry
    // of identical data matches but modifies nothing (except scrapedAt, which
    // always advances) and can never insert a duplicate thanks to the
    // unique (source, url) index.
    updated = result.modifiedCount ?? 0;
  }

  const sources: Record<string, number> = {};
  for (const job of unique) sources[job.source] = (sources[job.source] ?? 0) + 1;

  logger.info("ingest completed", {
    runId,
    received: jobs.length,
    unique: unique.length,
    inserted,
    updated,
    sources,
    durationMs: Date.now() - startedAt,
  });

  return { success: true, runId, received: jobs.length, inserted, updated, sources };
}
