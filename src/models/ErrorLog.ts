import { Schema, Document, model, Types } from "mongoose";

// Error severity levels
export type ErrorSeverity = "low" | "medium" | "high" | "critical";
export type ErrorSource = "mongodb" | "cloudflare" | "google-vision" | "gemini-vision" | "auth" | "payment" | "socket" | "api" | "system" | "unknown";

export interface IErrorLog extends Document {
  // Error identification
  errorCode: string;
  message: string;
  stack?: string;
  
  // Classification
  severity: ErrorSeverity;
  source: ErrorSource;
  endpoint?: string;
  method?: string;
  
  // Context
  userId?: Types.ObjectId;
  userEmail?: string;
  requestBody?: Record<string, any>;
  requestParams?: Record<string, any>;
  requestQuery?: Record<string, any>;
  
  // Response info
  statusCode?: number;
  responseTime?: number;
  
  // Environment
  environment: string;
  serverIp?: string;
  userAgent?: string;
  clientIp?: string;
  
  // Resolution
  resolved: boolean;
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
  resolutionNotes?: string;
  
  // Notifications
  emailSent: boolean;
  emailSentAt?: Date;
  emailRecipients?: string[];
  
  // Metadata
  metadata?: Record<string, any>;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const errorLogSchema = new Schema<IErrorLog>(
  {
    errorCode: { type: String, required: true, index: true },
    message: { type: String, required: true },
    stack: { type: String },
    
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
      index: true,
    },
    source: {
      type: String,
      enum: ["mongodb", "cloudflare", "google-vision", "gemini-vision", "auth", "payment", "socket", "api", "system", "unknown"],
      default: "unknown",
      index: true,
    },
    endpoint: { type: String },
    method: { type: String },
    
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    userEmail: { type: String },
    requestBody: { type: Schema.Types.Mixed },
    requestParams: { type: Schema.Types.Mixed },
    requestQuery: { type: Schema.Types.Mixed },
    
    statusCode: { type: Number },
    responseTime: { type: Number },
    
    environment: { type: String, default: process.env.NODE_ENV || "development" },
    serverIp: { type: String },
    userAgent: { type: String },
    clientIp: { type: String },
    
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolutionNotes: { type: String },
    
    emailSent: { type: Boolean, default: false },
    emailSentAt: { type: Date },
    emailRecipients: [{ type: String }],
    
    metadata: { type: Schema.Types.Mixed },
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Indexes for efficient querying
errorLogSchema.index({ occurredAt: -1 });
errorLogSchema.index({ severity: 1, resolved: 1 });
errorLogSchema.index({ source: 1, occurredAt: -1 });
errorLogSchema.index({ createdAt: -1 });

// TTL index to auto-delete resolved errors after 90 days
errorLogSchema.index(
  { resolvedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { resolved: true } }
);

export default model<IErrorLog>("ErrorLog", errorLogSchema);
