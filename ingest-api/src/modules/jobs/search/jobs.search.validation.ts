import { z } from "zod";
import { AppError, toValidationError } from "../../../middleware/error.middleware";
import { JOB_SOURCES, type JobSource } from "../jobs.types";
import {
  MAX_SEARCH_LIMIT,
  MAX_SUGGESTIONS_LIMIT,
  type ParsedSearchQuery,
  type ParsedSuggestionsQuery,
  type SearchSort,
} from "./jobs.search.types";

const MAX_TEXT_LENGTH = 200;
const MAX_PAGE = 1000;

/** Accept `?source=a&source=b` as well as `?source=a,b`. */
function joinCsv(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(",");
  return value;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const csvField = (max: number) =>
  z.preprocess(joinCsv, z.string().trim().max(max).optional());

const searchQuerySchema = z.object({
  q: z.preprocess(
    (v) => (Array.isArray(v) ? String(v[0] ?? "") : v),
    z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  ),
  source: csvField(500),
  company: csvField(MAX_TEXT_LENGTH),
  location: csvField(MAX_TEXT_LENGTH),
  department: csvField(MAX_TEXT_LENGTH),
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(20),
  sort: z.enum(["relevance", "updated", "company", "title"]).optional(),
});

const suggestionsQuerySchema = z.object({
  q: z.preprocess(
    (v) => (Array.isArray(v) ? String(v[0] ?? "") : v),
    z.string().trim().min(1, "q is required").max(MAX_TEXT_LENGTH),
  ),
  limit: z.coerce.number().int().min(1).max(MAX_SUGGESTIONS_LIMIT).default(10),
});

function parseSources(raw: string | undefined): JobSource[] {
  const values = splitCsv(raw);
  const allowed = new Set<string>(JOB_SOURCES);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid source: "${value}". Allowed: ${JOB_SOURCES.join(", ")}. ` +
          `Multiple values are comma-separated, e.g. source=Workday,Greenhouse`,
      );
    }
  }
  return values as JobSource[];
}

export function parseSearchQuery(raw: unknown): ParsedSearchQuery {
  const parsed = searchQuerySchema.safeParse(raw);
  if (!parsed.success) throw toValidationError(parsed.error);

  const q = parsed.data.q && parsed.data.q !== "" ? parsed.data.q : undefined;
  let sort: SearchSort = parsed.data.sort ?? (q ? "relevance" : "updated");
  // Relevance needs a query to score against; without one it degrades to recency.
  if (sort === "relevance" && !q) sort = "updated";

  return {
    q,
    sources: parseSources(parsed.data.source),
    companies: splitCsv(parsed.data.company),
    locations: splitCsv(parsed.data.location),
    departments: splitCsv(parsed.data.department),
    page: parsed.data.page,
    limit: parsed.data.limit,
    sort,
    skip: (parsed.data.page - 1) * parsed.data.limit,
  };
}

export function parseSuggestionsQuery(raw: unknown): ParsedSuggestionsQuery {
  const parsed = suggestionsQuerySchema.safeParse(raw);
  if (!parsed.success) throw toValidationError(parsed.error);
  return { q: parsed.data.q, limit: parsed.data.limit };
}
