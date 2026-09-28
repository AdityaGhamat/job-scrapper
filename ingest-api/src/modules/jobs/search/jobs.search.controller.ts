import type { NextFunction, Request, Response } from "express";
import { searchJobs, suggestJobs } from "./jobs.search.service";
import {
  parseSearchQuery,
  parseSuggestionsQuery,
} from "./jobs.search.validation";

export async function searchController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = parseSearchQuery(req.query);
    const result = await searchJobs(params);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function suggestionsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = parseSuggestionsQuery(req.query);
    const suggestions = await suggestJobs(params);
    res.status(200).json({ success: true, suggestions });
  } catch (err) {
    next(err);
  }
}
