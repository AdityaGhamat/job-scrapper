import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Job } from "../src/modules/jobs/jobs.model";

/**
 * True Atlas Search end-to-end suite. Skipped unless TEST_ATLAS_URI points at
 * an Atlas cluster with the jobs_search index created (see
 * search-index/jobs-search-index.json and npm run create-search-index).
 *
 *   TEST_ATLAS_URI="mongodb+srv://..." MONGODB_SEARCH_MODE=atlas npm test
 *
 * NOTE: this file intentionally does not run in CI without Atlas credentials.
 */
const ATLAS_URI = process.env.TEST_ATLAS_URI;
const enabled = Boolean(ATLAS_URI);

describe.skipIf(!enabled)("Atlas Search e2e (requires TEST_ATLAS_URI)", () => {
  const app = createApp();

  beforeAll(async () => {
    await mongoose.connect(ATLAS_URI as string);
    await Job.deleteMany({ url: { $regex: "^https://atlas-e2e\\.example/" } }).exec();
    await Job.insertMany([
      {
        company: "ACME",
        title: "Software Engineer",
        location: "Remote",
        department: "Engineering",
        url: "https://atlas-e2e.example/1",
        source: "Greenhouse",
        scrapedAt: new Date(),
      },
      {
        company: "ACME",
        title: "JavaScript Developer",
        location: "Remote",
        department: "Engineering",
        url: "https://atlas-e2e.example/2",
        source: "Workday",
        scrapedAt: new Date(),
      },
    ]);
    // Give Atlas Search a moment to index the fresh documents.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  });

  afterAll(async () => {
    await Job.deleteMany({ url: { $regex: "^https://atlas-e2e\\.example/" } }).exec();
    await mongoose.disconnect();
  });

  it("finds a typo'd query via fuzzy matching", async () => {
    const res = await request(app)
      .get("/internal/jobs/search")
      .query({ q: "sofware engineer" })
      .set({ Authorization: `Bearer ${process.env.INGEST_API_KEY}` });
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { title: string }) => d.title)).toContain("Software Engineer");
  });

  it("returns bounded autocomplete suggestions", async () => {
    const res = await request(app)
      .get("/internal/jobs/search/suggestions")
      .query({ q: "soft" })
      .set({ Authorization: `Bearer ${process.env.INGEST_API_KEY}` });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(10);
  });
});
