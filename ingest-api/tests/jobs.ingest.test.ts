import type { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Job } from "../src/modules/jobs/jobs.model";
import { authHeader, clearJobs, startTestDatabase, stopTestDatabase } from "./db";

const app = createApp();

const greenhouseJob = (overrides: Record<string, unknown> = {}) => ({
  Company: "OpenAI",
  Title: "Software Engineer",
  Location: "San Francisco, CA",
  Department: "Engineering",
  URL: "https://boards.greenhouse.io/openai/jobs/123",
  Updated: "2026-09-28T10:00:00Z",
  Source: "Greenhouse",
  ...overrides,
});

const workdayJob = (overrides: Record<string, unknown> = {}) => ({
  Company: "Disney",
  Title: "Software Engineer",
  Location: "Orlando, FL",
  Department: "",
  URL: "https://disney.wd5.myworkdayjobs.com/disneycareer/job/1",
  Updated: "2026-09-28",
  Source: "Workday",
  ...overrides,
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase(mongod);
});

beforeEach(async () => {
  await clearJobs();
});

describe("ingestion API", () => {
  it("1. GET /health returns ok without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("2. accepts a valid Greenhouse batch", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({
        runId: "run-greenhouse-1",
        jobs: [
          greenhouseJob(),
          greenhouseJob({ URL: "https://boards.greenhouse.io/openai/jobs/124" }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      runId: "run-greenhouse-1",
      received: 2,
      inserted: 2,
      updated: 0,
      sources: { Greenhouse: 2 },
    });
    expect(await Job.countDocuments().exec()).toBe(2);
  });

  it("3. accepts a valid Workday batch (empty Department allowed)", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "run-workday-1", jobs: [workdayJob()] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      received: 1,
      inserted: 1,
      sources: { Workday: 1 },
    });
    const stored = await Job.findOne({ source: "Workday" }).lean().exec();
    expect(stored?.department).toBeNull();
    expect(stored?.updated?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("4. accepts a mixed batch and reports per-source counts", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "run-mixed-1", jobs: [greenhouseJob(), workdayJob()] });
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual({ Greenhouse: 1, Workday: 1 });
    expect(res.body.inserted).toBe(2);
  });

  it("5. rejects a missing API key", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .send({ runId: "r", jobs: [workdayJob()] });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("6. rejects an invalid API key", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set({ Authorization: "Bearer wrong-key" })
      .send({ runId: "r", jobs: [workdayJob()] });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("7. rejects an invalid Source", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({
        runId: "r",
        jobs: [workdayJob({ Source: "LinkedIn" })],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("8. rejects a missing Company", async () => {
    const job = workdayJob();
    delete (job as Record<string, unknown>).Company;
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "r", jobs: [job] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("9. rejects a missing Title", async () => {
    const job = workdayJob();
    delete (job as Record<string, unknown>).Title;
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "r", jobs: [job] });
    expect(res.status).toBe(400);
  });

  it("10. rejects a missing URL", async () => {
    const job = workdayJob();
    delete (job as Record<string, unknown>).URL;
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "r", jobs: [job] });
    expect(res.status).toBe(400);
  });

  it("11. rejects an invalid URL", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "r", jobs: [workdayJob({ URL: "not-a-url" })] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("12. rejects an empty jobs array", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "r", jobs: [] });
    expect(res.status).toBe(400);
  });

  it("13. rejects a batch over MAX_INGEST_BATCH_SIZE", async () => {
    const jobs = Array.from({ length: 501 }, (_, i) =>
      workdayJob({ URL: `https://disney.wd5.myworkdayjobs.com/disneycareer/job/${i}` }),
    );
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "run-too-big", jobs });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("500");
    expect(await Job.countDocuments().exec()).toBe(0);
  });

  it("14. deduplicates jobs inside one batch by source+url (last wins)", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({
        runId: "run-dupe",
        jobs: [
          workdayJob({ Title: "First Title" }),
          workdayJob({ Title: "Latest Title" }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(2);
    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.sources).toEqual({ Workday: 1 });
    expect(await Job.countDocuments().exec()).toBe(1);
    const stored = await Job.findOne({ source: "Workday" }).lean().exec();
    expect(stored?.title).toBe("Latest Title");
  });

  it("15. submitting the same batch twice never creates duplicates", async () => {
    const body = {
      runId: "run-retry",
      jobs: [greenhouseJob(), workdayJob()],
    };
    const first = await request(app).post("/internal/jobs/ingest").set(authHeader()).send(body);
    expect(first.status).toBe(200);
    expect(first.body.inserted).toBe(2);

    const second = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ ...body, runId: "run-retry-again" });
    expect(second.status).toBe(200);
    expect(second.body.inserted).toBe(0);
    expect(await Job.countDocuments().exec()).toBe(2);
  });

  it("16. reports accurate bulk-write counts on insert then update", async () => {
    const jobs = [
      greenhouseJob(),
      workdayJob(),
      workdayJob({ URL: "https://disney.wd5.myworkdayjobs.com/disneycareer/job/2" }),
    ];
    const first = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "run-counts-1", jobs });
    expect(first.body).toMatchObject({
      success: true,
      received: 3,
      inserted: 3,
      updated: 0,
    });

    const changed = jobs.map((job, i) =>
      i === 0 ? { ...job, Title: "Staff Software Engineer" } : job,
    );
    const second = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({ runId: "run-counts-2", jobs: changed });
    expect(second.body.inserted).toBe(0);
    expect(second.body.updated).toBeGreaterThan(0);
    expect(await Job.countDocuments().exec()).toBe(3);
    const stored = await Job.findOne({ source: "Greenhouse" }).lean().exec();
    expect(stored?.title).toBe("Staff Software Engineer");
  });

  it("treats the same URL under different sources as different jobs", async () => {
    const url = "https://example.com/job/123";
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({
        runId: "run-cross-source",
        jobs: [
          greenhouseJob({ URL: url }),
          workdayJob({ URL: url }),
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    expect(await Job.countDocuments().exec()).toBe(2);
  });

  it("does not reject an otherwise valid job for an invalid Updated value", async () => {
    const res = await request(app)
      .post("/internal/jobs/ingest")
      .set(authHeader())
      .send({
        runId: "run-bad-date",
        jobs: [workdayJob({ Updated: "not-a-date" }), workdayJob({ URL: "https://x.example/2", Updated: "" })],
      });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    const stored = await Job.find().lean().exec();
    expect(stored.every((doc) => doc.updated === null)).toBe(true);
  });
});
