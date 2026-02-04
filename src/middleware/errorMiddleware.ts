import { Request, Response, NextFunction } from "express";
import { logError } from "../utils/emailService.js";
import { ErrorSource, ErrorSeverity } from "../models/ErrorLog.js";
import { AuthRequest } from "./authMiddleware.js";

// Determine error source from request path or error
const getErrorSource = (req: Request, error: Error): ErrorSource => {
  const path = req.path.toLowerCase();
  const errorMsg = error.message.toLowerCase();
  
  // Check path-based sources
  if (path.includes("/auth")) return "auth";
  if (path.includes("/payment") || path.includes("/razorpay")) return "payment";
  if (path.includes("/chat") || path.includes("/socket")) return "socket";
  
  // Check error message for specific services
  if (errorMsg.includes("mongo") || errorMsg.includes("mongoose") || errorMsg.includes("validation")) return "mongodb";
  if (errorMsg.includes("cloudflare") || errorMsg.includes("r2") || errorMsg.includes("s3")) return "cloudflare";
  if (errorMsg.includes("vision") || errorMsg.includes("google") || errorMsg.includes("label")) return "google-vision";
  
  return "api";
};

// Determine severity from status code
const getSeverity = (statusCode: number): ErrorSeverity => {
  if (statusCode >= 500) return "high";
  if (statusCode === 401 || statusCode === 403) return "medium";
  if (statusCode >= 400) return "low";
  return "medium";
};

// Sanitize request body (remove sensitive data)
const sanitizeBody = (body: any): any => {
  if (!body) return undefined;
  
  const sanitized = { ...body };
  const sensitiveFields = ["password", "token", "secret", "apiKey", "creditCard", "cvv", "pan", "gst"];
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  }
  
  return sanitized;
};

// Error handling middleware
export const errorHandler = async (
  err: Error & { statusCode?: number; code?: string },
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authReq = req as AuthRequest;
  const statusCode = err.statusCode || 500;
  const source = getErrorSource(req, err);
  const severity = getSeverity(statusCode);
  
  // Log the error
  try {
    await logError({
      message: err.message,
      stack: err.stack,
      source,
      severity,
      errorCode: err.code || `${source.toUpperCase()}_${statusCode}`,
      
      endpoint: req.originalUrl,
      method: req.method,
      statusCode,
      
      userId: authReq.user?._id,
      userEmail: authReq.user?.email,
      
      requestBody: sanitizeBody(req.body),
      requestParams: req.params,
      requestQuery: req.query as Record<string, any>,
      
      userAgent: req.get("User-Agent"),
      clientIp: req.ip || req.connection.remoteAddress,
    });
  } catch (logErr) {
    console.error("Failed to log error:", logErr);
  }
  
  // Send response
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === "production" 
      ? "An error occurred" 
      : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};

// Async handler wrapper to catch errors
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Not found handler
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`) as Error & { statusCode: number };
  error.statusCode = 404;
  next(error);
};

export default { errorHandler, asyncHandler, notFoundHandler };
