import express, { type Express } from "express";
import { config } from "./config/env";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware";
import { jobsRouter } from "./modules/jobs/jobs.routes";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/internal/jobs", jobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
