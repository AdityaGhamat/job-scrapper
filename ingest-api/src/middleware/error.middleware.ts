import type { NextFunction, Request, Response } from "express";
import type { ZodError } from "zod";
import { logger } from "../utils/logger";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function toValidationError(err: ZodError): AppError {
  return new AppError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  const entityError = err as { type?: string; status?: number };
  if (entityError?.type === "entity.too.large") {
    res.status(413).json({
      success: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured size limit",
      },
    });
    return;
  }

  if (entityError?.type === "entity.parse.failed") {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
    });
    return;
  }

  logger.error("unhandled error", {
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
}
