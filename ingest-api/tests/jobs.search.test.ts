import type { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Job } from "../src/modules/jobs/jobs.model";
import { authHeader, startTestDatabase, stopTestDatabase } from "./db";

const app = createApp();

function seedJob(overrides: Record<string, unknown>) {
  return {
    company: "Disney",
    title: "Software Engineer",
    location: "Orlando, FL",
    department: "Engineering",
    url: `https://example.com/job/${Math.random().toString(36).slice(2)}`,
    updated: new Date("2026-09-20T00:00:00.000Z"),
    source: "Workday",
    scrapedAt: new Date("2026-09-28T00:00:00.000Z"),
    ...overrides,
  };
}

const SEED = [
  seedJob({ company: "Disney", title: "Software Engineer", location: "Orlando, FL", source: "Workday", url: "https://example.com/job/1", updated: new Date("2026-09-20T00:00:00.000Z") }),
  seedJob({ company: "Disney", title: "Senior Software Engineer", location: "London, UK", source: "Workday", url: "https://example.com/job/2", updated: new Date("2026-09-25T00:00:00.000Z") }),
  seedJob({ company: "OpenAI", title: "Software Engineer", location: "San Francisco, CA", source: "Greenhouse", url: "https://example.com/job/3", updated: new Date("2026-09-28T00:00:00.000Z") }),
  seedJob({ company: "OpenAI", title: "Research Scientist", location: "San Francisco, CA", department: "Research", source: "Greenhouse", url: "https://example.com/job/4", updated: new Date("2026-09-27T00:00:00.000Z") }),
  seedJob({ company: "Stripe", title: "Data Analyst", location: "New York, NY", department: "Data", source: "Greenhouse", url: "https://example.com/job/5", updated: new Date("2026-09-10T00:00:00.000Z") }),
  seedJob({ company: "Figma", title: "Product Designer", location: "Remote", department: "Design", source: "Greenhouse", url: "https://example.com/job/6", updated: new Date("2026-09-15T00:00:00.000Z") }),
  seedJob({ company: "Adobe", title: "Frontend Engineer (React)", location: "San Jose, CA", source: "Workday", url: "https://example.com/job/7", updated: new Date("2026-09-22T00:00:00.000Z") }),
  seedJob({ company: "Nvidia", title: "JavaScript Developer", location: "Santa Clara, CA", source: "Workday", url: "https://example.com/job/8", updated: new Date("2026-09-23T00:00:00.000Z") }),
  seedJob({ company: "Walmart", title: "Store Manager", location: "Bentonville, AR", department: "Operations", source: "Workday", url: "https://example.com/job/9", updated: new Date("2026-09-05T00:00:00.000Z") }),
  seedJob({ company: "Salesforce", title: "Software Engineering Manager", location: "Seattle, WA", source: "Workday", url: "https://example.com/job/10", updated: new Date("2026-09-24T00:00:00.000Z") }),
  seedJob({ company: "Anthropic", title: "Prompt Engineer", location: "Remote", department: "Research", source: "Greenhouse", url: "https://example.com/job/11", updated: new Date("2026-09-26T00:00:00.000Z") }),
  seedJob({ company: "Vercel", title: "Software Engineer", location: "Remote", source: "Greenhouse", url: "https://example.com/job/12", updated: null }),
];

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await startTestDatabase();
  await Job.insertMany(SEED);
});

afterAll(async () => {
  await stopTestDatabase(mongod);
});

function titles(body: { data: Array<{ title: string }> }): string[] {
  return body.data.map((d) => d.title);
}

describe("search API (text-mode integration)", () => {
  it("1. search without q returns jobs with default updated sorting", async () => {
    const res = await request(app).get("/internal/jobs/search").set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination.total).toBe(12);
    expect(res.body.data).toHaveLength(12);
    const updated = res.body.data.map((d: { updated: string | null }) => d.updated);
    // Most recently updated first; null updated last.
    expect(updated[0]).toBe("2026-09-28T00:00:00.000Z");
    expect(updated[updated.length - 1]).toBeNull();
  });

  it("2. search by title text", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "software engineer" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(4);
    expect(titles(res.body)).toContain("Senior Software Engineer");
    expect(res.body.data[0].score).toEqual(expect.any(Number));
  });

  it("3. search by company filter (case-insensitive exact)", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ company: "disney" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.data.every((d: { company: string }) => d.company === "Disney")).toBe(true);
  });

  it("4. search by location filter", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ location: "Remote" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(3);
  });

  it("5. search by department filter", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ department: "Engineering" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(7);
  });

  it("6. search by source filter", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ source: "Workday" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(6);
    expect(res.body.data.every((d: { source: string }) => d.source === "Workday")).toBe(true);
  });

  it("7. search with multiple filters (AND) incl. multi-value source", async () => {
    const anded = await request(app)
      .get("/internal/jobs/search")
      .query({ company: "Disney", source: "Workday" })
      .set(authHeader());
    expect(anded.body.pagination.total).toBe(2);

    const multi = await request(app)
      .get("/internal/jobs/search")
      .query({ source: "Workday,Greenhouse" })
      .set(authHeader());
    expect(multi.body.pagination.total).toBe(12);

    const none = await request(app)
      .get("/internal/jobs/search")
      .query({ company: "Disney", source: "Greenhouse" })
      .set(authHeader());
    expect(none.body.pagination.total).toBe(0);
  });

  it("8. search with q + filters", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "react", source: "Greenhouse" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);

    const match = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "react", source: "Workday" })
      .set(authHeader());
    expect(match.body.pagination.total).toBe(1);
    expect(titles(match.body)).toContain("Frontend Engineer (React)");
  });

  it("9. fuzzy query returns a well-formed response (fuzzy matching itself needs Atlas)", async () => {
    // $text has no fuzzy matching, so a typo may match nothing here. The
    // Atlas pipeline's fuzzy clauses are asserted in jobs.search.pipeline.test.ts.
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "sofware engineer" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20 });
  });

  it("10. pagination slices inside the database", async () => {
    const page2 = await request(app)
      .get("/internal/jobs/search")
      .query({ limit: 5, page: 2 })
      .set(authHeader());
    expect(page2.body.pagination).toMatchObject({
      page: 2,
      limit: 5,
      total: 12,
      totalPages: 3,
      hasNextPage: true,
    });
    expect(page2.body.data).toHaveLength(5);

    const page3 = await request(app)
      .get("/internal/jobs/search")
      .query({ limit: 5, page: 3 })
      .set(authHeader());
    expect(page3.body.pagination).toMatchObject({ page: 3, totalPages: 3, hasNextPage: false });
    expect(page3.body.data).toHaveLength(2);
  });

  it("11. enforces the page-size limit", async () => {
    const tooBig = await request(app)
      .get("/internal/jobs/search")
      .query({ limit: 51 })
      .set(authHeader());
    expect(tooBig.status).toBe(400);

    const max = await request(app)
      .get("/internal/jobs/search")
      .query({ limit: 50 })
      .set(authHeader());
    expect(max.status).toBe(200);
    expect(max.body.data).toHaveLength(12);
  });

  it("12. sorts by relevance with non-increasing scores", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "engineer", sort: "relevance" })
      .set(authHeader());
    expect(res.status).toBe(200);
    const scores = res.body.data.map((d: { score?: number }) => d.score);
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.every((s: unknown) => typeof s === "number")).toBe(true);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("13. sorts by updated descending", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ sort: "updated" })
      .set(authHeader());
    expect(res.status).toBe(200);
    const values = res.body.data.map((d: { updated: string | null }) => d.updated);
    const nonNull = values.filter((v: string | null): v is string => v !== null);
    expect(nonNull).toEqual([...nonNull].sort().reverse());
    expect(values[values.length - 1]).toBeNull();
  });

  it("14. returns an empty result set cleanly", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "zzzzznonexistentterm" })
      .set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false },
    });
  });

  it("15. rejects an invalid q", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "x".repeat(201) })
      .set(authHeader());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("16. rejects an invalid source", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ source: "LinkedIn" })
      .set(authHeader());
    expect(res.status).toBe(400);
  });

  it("17. rejects an invalid page", async () => {
    for (const page of ["0", "-1", "abc"]) {
      const res = await request(app)
        .get("/internal/jobs/search")
        .query({ page })
        .set(authHeader());
      expect(res.status).toBe(400);
    }
  });

  it("18. rejects an invalid limit", async () => {
    for (const limit of ["0", "51", "abc"]) {
      const res = await request(app)
        .get("/internal/jobs/search")
        .query({ limit })
        .set(authHeader());
      expect(res.status).toBe(400);
    }
  });

  it("19. rejects an invalid sort", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ sort: "salary" })
      .set(authHeader());
    expect(res.status).toBe(400);
  });

  it("20. duplicate search requests return identical results", async () => {
    const query = { q: "engineer", source: "Workday", page: "1", limit: "10" };
    const first = await request(app).get("/internal/jobs/search").query(query).set(authHeader());
    const second = await request(app).get("/internal/jobs/search").query(query).set(authHeader());
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("requires auth on search and suggestions", async () => {
    const search = await request(app).get("/internal/jobs/search").query({ q: "x" });
    expect(search.status).toBe(401);
    const suggestions = await request(app).get("/internal/jobs/search/suggestions").query({ q: "x" });
    expect(suggestions.status).toBe(401);
  });

  it("suggestions in text mode fail clearly instead of faking autocomplete", async () => {
    const res = await request(app)
      .get("/internal/jobs/search/suggestions")
      .query({ q: "soft" })
      .set(authHeader());
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("SUGGESTIONS_UNAVAILABLE");
  });

  it("result items expose the clean public shape", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "designer" })
      .set(authHeader());
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      company: "Figma",
      title: "Product Designer",
      location: "Remote",
      department: "Design",
      url: "https://example.com/job/6",
      updated: "2026-09-15T00:00:00.000Z",
      source: "Greenhouse",
      score: expect.any(Number),
    });
  });
});
