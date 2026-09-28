export const JOB_SOURCES = ["Greenhouse", "Workday"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/**
 * Job payload exactly as produced by the Python scraper.
 * Field names are intentionally Capitalized here; normalization to the
 * internal lowercase shape happens in the ingestion service.
 */
export interface ScraperJobInput {
  Company: string;
  Title: string;
  Location?: string;
  Department?: string;
  URL: string;
  Updated?: unknown;
  Source: JobSource;
}

export interface NormalizedJob {
  company: string;
  title: string;
  location: string;
  department: string | null;
  url: string;
  updated: Date | null;
  source: JobSource;
  scrapedAt: Date;
}

export interface IngestRequestBody {
  runId: string;
  jobs: ScraperJobInput[];
}

export interface IngestResponseBody {
  success: true;
  runId: string;
  /** Raw number of jobs received in the request (before in-batch dedupe). */
  received: number;
  /** Documents newly inserted by this request (bulkWrite upsertedCount). */
  inserted: number;
  /** Existing documents modified by this request (bulkWrite modifiedCount). */
  updated: number;
  /** Per-source counts of unique jobs processed. */
  sources: Record<string, number>;
}
