import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env";
import { AppError } from "./error.middleware";

function isValidKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    next(
      new AppError(
        401,
        "UNAUTHORIZED",
        "Missing or invalid Authorization header. Expected: Bearer <api-key>",
      ),
    );
    return;
  }
  const provided = header.slice("Bearer ".length).trim();
  if (!isValidKey(provided, config.INGEST_API_KEY)) {
    next(new AppError(401, "UNAUTHORIZED", "Invalid API key"));
    return;
  }
  next();
}
