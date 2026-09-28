import type { FilterQuery, PipelineStage } from "mongoose";
import { config } from "../../../config/env";
import { AppError } from "../../../middleware/error.middleware";
import { logger } from "../../../utils/logger";
import { Job, type JobDocument } from "../jobs.model";
import type { JobSource } from "../jobs.types";
import type {
  ParsedSearchQuery,
  ParsedSuggestionsQuery,
  SearchResponseBody,
  SearchResultItem,
  SearchSort,
  SuggestionItem,
  SuggestionType,
} from "./jobs.search.types";

/** Case-insensitive exact matching that can still use normal indexes. */
const CASE_INSENSITIVE_COLLATION = { locale: "en", strength: 2 } as const;

/** Relevance hierarchy: title matches outrank company, which outrank the rest. */
const TITLE_BOOST = 3;
const COMPANY_BOOST = 2;

function exactOrIn(values: string[]): string | { $in: string[] } {
  return values.length === 1 ? values[0] : { $in: values };
}

/**
 * Exact-match filters shared by every search path (Atlas $match stage and
 * text-mode find filter), so filtering behaves the same in all modes.
 * Multi-value filters use $in (comma-separated in the query string).
 */
export function buildFilterMatch(params: ParsedSearchQuery): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (params.sources.length > 0) match.source = exactOrIn(params.sources);
  if (params.companies.length > 0) match.company = exactOrIn(params.companies);
  if (params.locations.length > 0) match.location = exactOrIn(params.locations);
  if (params.departments.length > 0) match.department = exactOrIn(params.departments);
  return match;
}

export function buildAtlasSearchStage(q: string, indexName: string): Record<string, unknown> {
  return {
    $search: {
      index: indexName,
      compound: {
        should: [
          {
            text: {
              query: q,
              path: "title",
              fuzzy: { maxEdits: 2, prefixLength: 1 },
              score: { boost: { value: TITLE_BOOST } },
            },
          },
          {
            text: {
              query: q,
              path: "company",
              fuzzy: { maxEdits: 2, prefixLength: 1 },
              score: { boost: { value: COMPANY_BOOST } },
            },
          },
          {
            text: {
              query: q,
              path: ["location", "department"],
              fuzzy: { maxEdits: 1, prefixLength: 1 },
            },
          },
        ],
        minimumShouldMatch: 1,
      },
    },
  };
}

function buildAtlasSortStage(sort: SearchSort): Record<string, 1 | -1> {
  // _id is a final stability tiebreak so equal keys never flip between requests.
  switch (sort) {
    case "relevance":
      return { searchScore: -1, scrapedAt: -1, _id: 1 };
    case "updated":
      return { updated: -1, scrapedAt: -1, _id: 1 };
    case "company":
      return { company: 1, scrapedAt: -1, _id: 1 };
    case "title":
      return { title: 1, scrapedAt: -1, _id: 1 };
  }
}

/**
 * Pure pipeline builder (no I/O) so the Atlas Search shape is unit-testable
 * without an Atlas cluster.
 */
export function buildAtlasSearchPipeline(
  params: ParsedSearchQuery,
  indexName: string,
): Record<string, unknown>[] {
  const pipeline: Record<string, unknown>[] = [];

  if (params.q) {
    pipeline.push(buildAtlasSearchStage(params.q, indexName));
    // Materialize the relevance score so later stages ($sort/$facet) can use it.
    pipeline.push({ $addFields: { searchScore: { $meta: "searchScore" } } });
  }

  const match = buildFilterMatch(params);
  if (Object.keys(match).length > 0) pipeline.push({ $match: match });

  pipeline.push({ $sort: buildAtlasSortStage(params.sort) });

  // Count + page inside MongoDB; Node.js never sees more than one page.
  pipeline.push({
    $facet: {
      metadata: [{ $count: "total" }],
      data: [{ $skip: params.skip }, { $limit: params.limit }],
    },
  });

  return pipeline;
}

function toResultItem(
  doc: Record<string, unknown>,
  score: number | undefined,
): SearchResultItem {
  const updated = doc.updated;
  const item: SearchResultItem = {
    id: String(doc._id),
    company: String(doc.company ?? ""),
    title: String(doc.title ?? ""),
    location: String(doc.location ?? ""),
    department: (doc.department as string | null) ?? null,
    url: String(doc.url ?? ""),
    updated: updated ? new Date(updated as string | Date).toISOString() : null,
    source: doc.source as JobSource,
  };
  if (score !== undefined) item.score = score;
  return item;
}

function buildResponse(
  items: SearchResultItem[],
  total: number,
  params: ParsedSearchQuery,
): SearchResponseBody {
  const totalPages = total === 0 ? 0 : Math.ceil(total / params.limit);
  return {
    success: true,
    data: items,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasNextPage: params.page < totalPages,
    },
  };
}

async function runAtlasSearch(params: ParsedSearchQuery): Promise<SearchResponseBody> {
  const pipeline = buildAtlasSearchPipeline(params, config.MONGODB_SEARCH_INDEX_NAME);
  const agg = Job.aggregate(pipeline as unknown as PipelineStage[]).collation(
    CASE_INSENSITIVE_COLLATION,
  );
  const result = (await agg.exec()) as Array<{
    metadata: Array<{ total: number }>;
    data: Array<Record<string, unknown>>;
  }>;

  const first = result[0] ?? { metadata: [], data: [] };
  const total = first.metadata[0]?.total ?? 0;
  const items = first.data.map((doc) =>
    toResultItem(
      doc,
      params.q && typeof doc.searchScore === "number" ? doc.searchScore : undefined,
    ),
  );
  return buildResponse(items, total, params);
}

/**
 * Strip $text query-language characters so user input is always treated as
 * plain terms (a leading "-" would otherwise negate a term).
 */
export function sanitizeTextQuery(q: string): string {
  return q
    .replace(/["\\]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+/, ""))
    .filter((token) => token !== "")
    .join(" ");
}

async function runTextSearch(params: ParsedSearchQuery): Promise<SearchResponseBody> {
  const filter: FilterQuery<JobDocument> = { ...buildFilterMatch(params) };
  const textQuery = params.q ? sanitizeTextQuery(params.q) : "";

  if (params.q) {
    if (textQuery === "") {
      return buildResponse([], 0, params);
    }
    filter.$text = { $search: textQuery };
  }

  const total = await Job.countDocuments(filter).collation(CASE_INSENSITIVE_COLLATION).exec();

  const query = Job.find(
    filter,
    params.q ? { score: { $meta: "textScore" } } : {},
  ).collation(CASE_INSENSITIVE_COLLATION);

  switch (params.sort) {
    case "relevance":
      // Reachable only when q is present (validation maps relevance->updated otherwise).
      query.sort({ score: { $meta: "textScore" }, _id: 1 });
      break;
    case "updated":
      query.sort({ updated: -1, scrapedAt: -1, _id: 1 });
      break;
    case "company":
      query.sort({ company: 1, scrapedAt: -1, _id: 1 });
      break;
    case "title":
      query.sort({ title: 1, scrapedAt: -1, _id: 1 });
      break;
  }

  const docs = await query.skip(params.skip).limit(params.limit).lean().exec();
  const items = docs.map((doc) => {
    const withScore = doc as Record<string, unknown>;
    return toResultItem(
      withScore,
      params.q && typeof withScore.score === "number"
        ? (withScore.score as number)
        : undefined,
    );
  });
  return buildResponse(items, total, params);
}

function isSearchUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(\$search|search index|atlas search|unrecognized pipeline stage)/i.test(
    message,
  );
}

export async function searchJobs(params: ParsedSearchQuery): Promise<SearchResponseBody> {
  const startedAt = Date.now();
  const mode = config.MONGODB_SEARCH_MODE;

  let result: SearchResponseBody;
  let effectiveMode = mode;
  try {
    if (mode === "text") {
      result = await runTextSearch(params);
    } else if (mode === "auto") {
      try {
        result = await runAtlasSearch(params);
      } catch (err) {
        if (!isSearchUnavailableError(err)) throw err;
        logger.warn("atlas search unavailable, falling back to text search");
        effectiveMode = "text";
        result = await runTextSearch(params);
      }
    } else {
      try {
        result = await runAtlasSearch(params);
      } catch (err) {
        if (isSearchUnavailableError(err)) {
          throw new AppError(
            503,
            "SEARCH_UNAVAILABLE",
            `MongoDB Search is unavailable. Create the "${config.MONGODB_SEARCH_INDEX_NAME}" ` +
              `Atlas Search index (see search-index/jobs-search-index.json) or set ` +
              `MONGODB_SEARCH_MODE=text for the fallback.`,
          );
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error("search failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    throw new AppError(500, "SEARCH_FAILED", "Job search failed");
  }

  logger.info("search completed", {
    mode: effectiveMode,
    hasQuery: Boolean(params.q),
    filters: {
      sources: params.sources,
      companies: params.companies,
      locations: params.locations,
      departments: params.departments,
    },
    sort: params.sort,
    page: params.page,
    limit: params.limit,
    total: result.pagination.total,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

const SUGGESTION_FIELDS: Array<{ field: "title" | "company" | "location"; type: SuggestionType }> = [
  { field: "title", type: "title" },
  { field: "company", type: "company" },
  { field: "location", type: "location" },
];

async function runAtlasSuggestions(
  params: ParsedSuggestionsQuery,
): Promise<SuggestionItem[]> {
  const index = config.MONGODB_SEARCH_INDEX_NAME;

  const perField = await Promise.all(
    SUGGESTION_FIELDS.map(async ({ field }) => {
      const docs = (await Job.aggregate([
        { $search: { index, autocomplete: { query: params.q, path: field } } },
        { $limit: params.limit * 2 },
        { $project: { _id: 0, value: `$${field}` } },
      ]).exec()) as Array<{ value?: unknown }>;
      const seen = new Set<string>();
      const values: string[] = [];
      for (const doc of docs) {
        if (typeof doc.value !== "string") continue;
        const value = doc.value.trim();
        if (value === "" || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
      }
      return values;
    }),
  );

  // Round-robin across title/company/location so one field cannot crowd out the rest.
  const suggestions: SuggestionItem[] = [];
  for (let i = 0; suggestions.length < params.limit; i += 1) {
    let added = false;
    for (let f = 0; f < perField.length && suggestions.length < params.limit; f += 1) {
      const value = perField[f][i];
      if (value === undefined) continue;
      suggestions.push({ type: SUGGESTION_FIELDS[f].type, value });
      added = true;
    }
    if (!added) break;
  }
  return suggestions;
}

export async function suggestJobs(
  params: ParsedSuggestionsQuery,
): Promise<SuggestionItem[]> {
  if (config.MONGODB_SEARCH_MODE === "text") {
    throw new AppError(
      501,
      "SUGGESTIONS_UNAVAILABLE",
      "Autocomplete suggestions require MongoDB Atlas Search " +
        "(autocomplete index). MONGODB_SEARCH_MODE=text does not support them.",
    );
  }
  try {
    return await runAtlasSuggestions(params);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isSearchUnavailableError(err)) {
      throw new AppError(
        503,
        "SUGGESTIONS_UNAVAILABLE",
        `Autocomplete suggestions require the "${config.MONGODB_SEARCH_INDEX_NAME}" ` +
          `Atlas Search index with autocomplete mappings.`,
      );
    }
    logger.error("suggestions failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    throw new AppError(500, "SEARCH_FAILED", "Suggestions lookup failed");
  }
}
