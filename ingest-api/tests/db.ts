import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Job } from "../src/modules/jobs/jobs.model";

export async function startTestDatabase(): Promise<MongoMemoryServer> {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Job.syncIndexes();
  return mongod;
}

export async function stopTestDatabase(mongod: MongoMemoryServer | undefined): Promise<void> {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

export async function clearJobs(): Promise<void> {
  await Job.deleteMany({});
}

export function testApiKey(): string {
  return process.env.INGEST_API_KEY ?? "test-api-key";
}

export function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${testApiKey()}` };
}
