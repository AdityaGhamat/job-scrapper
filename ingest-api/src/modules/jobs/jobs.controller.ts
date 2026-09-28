import type { NextFunction, Request, Response } from "express";
import { config } from "../../config/env";
import { toValidationError } from "../../middleware/error.middleware";
import { ingestJobs } from "./jobs.service";
import { createIngestBodySchema } from "./jobs.validation";

export async function ingestController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const schema = createIngestBodySchema(config.MAX_INGEST_BATCH_SIZE);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(toValidationError(parsed.error));
      return;
    }
    const result = await ingestJobs(parsed.data.runId, parsed.data.jobs);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
