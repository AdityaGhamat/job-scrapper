import { z } from "zod";

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const scraperJobSchema = z.object({
  Company: z.string().trim().min(1, "Company is required").max(200),
  Title: z.string().trim().min(1, "Title is required").max(500),
  Location: z.string().max(500).optional().default(""),
  Department: z.string().max(500).optional().default(""),
  URL: z
    .string()
    .trim()
    .min(1, "URL is required")
    .max(2048)
    .refine(isHttpUrl, { message: "URL must be a valid http(s) URL" }),
  // Accepted as-is; date parsing happens in the service so that an
  // invalid/empty date never invalidates an otherwise valid job.
  Updated: z.unknown().optional(),
  Source: z.enum(["Greenhouse", "Workday"]),
});

export type ScraperJobSchemaOutput = z.infer<typeof scraperJobSchema>;

export function createIngestBodySchema(maxBatchSize: number) {
  return z.object({
    runId: z.string().trim().min(1, "runId is required").max(128),
    jobs: z
      .array(scraperJobSchema)
      .min(1, "jobs must contain at least 1 item")
      .max(
        maxBatchSize,
        `jobs must contain at most ${maxBatchSize} items (MAX_INGEST_BATCH_SIZE)`,
      ),
  });
}

export type IngestBodySchemaOutput = z.infer<ReturnType<typeof createIngestBodySchema>>;
