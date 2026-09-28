import { Router } from "express";
import { requireApiKey } from "../../middleware/auth.middleware";
import { ingestController } from "./jobs.controller";
import {
  searchController,
  suggestionsController,
} from "./search/jobs.search.controller";

export const jobsRouter = Router();

jobsRouter.post("/ingest", requireApiKey, ingestController);
jobsRouter.get("/search/suggestions", requireApiKey, suggestionsController);
jobsRouter.get("/search", requireApiKey, searchController);
