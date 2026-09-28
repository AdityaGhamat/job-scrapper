import mongoose, { Document, Model, Schema } from "mongoose";
import type { JobSource } from "./jobs.types";

export interface JobDocument extends Document {
  company: string;
  title: string;
  location: string;
  department: string | null;
  url: string;
  updated: Date | null;
  source: JobSource;
  scrapedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<JobDocument>(
  {
    company: { type: String, required: true, trim: true, maxlength: 200 },
    title: { type: String, required: true, trim: true, maxlength: 500 },
    location: { type: String, required: false, default: "", maxlength: 500 },
    department: { type: String, required: false, default: null, maxlength: 500 },
    url: { type: String, required: true, maxlength: 2048 },
    updated: { type: Date, required: false, default: null },
    source: { type: String, required: true, enum: ["Greenhouse", "Workday"] },
    scrapedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

// Identity: one job per (source, url). Prevents duplicates across retries,
// reruns, and concurrent GitHub Actions runners.
jobSchema.index({ source: 1, url: 1 }, { unique: true, name: "source_url_unique" });

// Exact-filter support for search-without-q and post-$search $match stages.
jobSchema.index({ company: 1 }, { name: "company_idx" });
jobSchema.index({ source: 1, company: 1 }, { name: "source_company_idx" });

// Recency sorting and run-based inspection.
jobSchema.index({ scrapedAt: -1 }, { name: "scrapedAt_idx" });

// Fallback only: used when MONGODB_SEARCH_MODE=text|auto-without-atlas.
// Weights mirror the Atlas Search boost hierarchy (title > company > rest).
jobSchema.index(
  { title: "text", company: "text", location: "text", department: "text" },
  {
    name: "jobs_text_fallback",
    weights: { title: 10, company: 5, location: 2, department: 1 },
  },
);

export const Job: Model<JobDocument> =
  mongoose.models.Job ?? mongoose.model<JobDocument>("Job", jobSchema);
