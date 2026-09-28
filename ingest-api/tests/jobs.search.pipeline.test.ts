import { describe, expect, it } from "vitest";
import {
  buildAtlasSearchPipeline,
  buildFilterMatch,
} from "../src/modules/jobs/search/jobs.search.service";
import type { ParsedSearchQuery } from "../src/modules/jobs/search/jobs.search.types";
import { parseSearchQuery } from "../src/modules/jobs/search/jobs.search.validation";

function params(query: Record<string, unknown>): ParsedSearchQuery {
  return parseSearchQuery(query);
}

describe("Atlas Search pipeline builder (no database needed)", () => {
  it("puts $search first with the configured index and minimumShouldMatch", () => {
    const pipeline = buildAtlasSearchPipeline(params({ q: "software" }), "jobs_search");
    expect(pipeline[0]).toMatchObject({
      $search: { index: "jobs_search", compound: { minimumShouldMatch: 1 } },
    });
  });

  it("boosts title above company above location/department", () => {
    const pipeline = buildAtlasSearchPipeline(params({ q: "engineer" }), "jobs_search");
    const search = pipeline[0] as {
      $search: { compound: { should: Array<{ text: { path: unknown; score?: { boost: { value: number } } } }> } };
    };
    const clauses = search.$search.compound.should;
    expect(clauses).toHaveLength(3);
    const boostOf = (path: string) =>
      clauses.find((c) => c.text.path === path)?.text.score?.boost.value;
    expect(boostOf("title")).toBe(3);
    expect(boostOf("company")).toBe(2);
    expect(clauses[0].text.path).toBe("title");
  });

  it("enables fuzzy matching on every text clause", () => {
    const pipeline = buildAtlasSearchPipeline(params({ q: "sofware" }), "jobs_search");
    const search = pipeline[0] as {
      $search: { compound: { should: Array<{ text: { fuzzy?: { maxEdits: number } } }> } };
    };
    for (const clause of search.$search.compound.should) {
      expect(clause.text.fuzzy?.maxEdits).toBeGreaterThanOrEqual(1);
    }
  });

  it("applies exact filters in a $match stage with $in for multi-values", () => {
    const pipeline = buildAtlasSearchPipeline(
      params({ q: "engineer", source: "Workday,Greenhouse", company: "Disney" }),
      "jobs_search",
    );
    const matchStage = pipeline.find((stage) => "$match" in stage) as {
      $match: Record<string, unknown>;
    };
    expect(matchStage).toBeDefined();
    expect(matchStage.$match).toEqual({
      source: { $in: ["Workday", "Greenhouse"] },
      company: "Disney",
    });
    expect(buildFilterMatch(params({ location: "Remote" }))).toEqual({ location: "Remote" });
  });

  it("sorts by materialized searchScore for relevance", () => {
    const pipeline = buildAtlasSearchPipeline(
      params({ q: "engineer", sort: "relevance" }),
      "jobs_search",
    );
    expect(pipeline).toContainEqual({
      $addFields: { searchScore: { $meta: "searchScore" } },
    });
    const sortStage = pipeline.find((stage) => "$sort" in stage);
    expect(sortStage).toEqual({ $sort: { searchScore: -1, scrapedAt: -1, _id: 1 } });
  });

  it("paginates with $facet skip/limit inside MongoDB", () => {
    const pipeline = buildAtlasSearchPipeline(params({ q: "x", page: "2", limit: "20" }), "idx");
    const facet = pipeline.find((stage) => "$facet" in stage) as {
      $facet: { metadata: unknown[]; data: unknown[] };
    };
    expect(facet.$facet.metadata).toEqual([{ $count: "total" }]);
    expect(facet.$facet.data).toEqual([{ $skip: 20 }, { $limit: 20 }]);
  });

  it("omits $search entirely when q is absent (index-backed $match path)", () => {
    const pipeline = buildAtlasSearchPipeline(params({ source: "Workday" }), "jobs_search");
    expect(pipeline.some((stage) => "$search" in stage)).toBe(false);
    expect(pipeline[0]).toEqual({ $match: { source: "Workday" } });
    expect(pipeline[1]).toEqual({ $sort: { updated: -1, scrapedAt: -1, _id: 1 } });
  });

  it("resolves defaults: relevance with q, updated without", () => {
    expect(params({ q: "x" }).sort).toBe("relevance");
    expect(params({}).sort).toBe("updated");
    expect(params({ sort: "relevance" }).sort).toBe("updated");
  });
});
