import express from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import path from "path";
import { createServer } from "http";
import { connectDB } from "./config/db.js";
import { initializeSocket } from "./socket/socketHandler.js";
import { initializeTagWorker } from "./workers/tagWorker.js"; // ✅ Tag Worker
import { getRedisCommandClient } from "./config/redis.js";

// Routes Imports
import authRoutes from "./routes/authRoutes.js";
import imagePostRoutes from "./routes/imagePostRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import commentRoutes from "./routes/commentRoutes.js";
import chatRoutes from "./routes/chatRoutes.js"; // ✅ CHAT ROUTES
import adRoutes from "./routes/adRoutes.js";     // ✅ AD ROUTES
import orderRoutes from "./routes/orderRoutes.js"; // ✅ ORDER ROUTES
import complianceRoutes from "./routes/complianceRoutes.js"; // ✅ COMPLIANCE ROUTES
import notificationRoutes from "./routes/notificationRoutes.js"; // ✅ NOTIFICATION ROUTES
import searchRoutes from "./routes/searchRoutes.js"; // ✅ SEARCH ROUTES
import contactRoutes from "./routes/contactRoutes.js"; // ✅ CONTACT ROUTES
import legalRoutes from "./routes/legalRoutes.js"; // ✅ LEGAL ROUTES
import addressRoutes from "./routes/addressRoutes.js"; // ✅ ADDRESS ROUTES

// Error handling middleware
import { errorHandler, notFoundHandler } from "./middleware/errorMiddleware.js";

// ==========================================
// ✅ ENVIRONMENT VALIDATION (Must be first!)
// ==========================================
const requiredEnvVars = [
  "MONGO_URI",
  "JWT_SECRET",
  "CF_ACCOUNT_ID",
  "CF_ACCESS_KEY_ID", 
  "CF_SECRET_ACCESS_KEY",
  "CF_BUCKET_NAME",
];

const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingVars.length > 0) {
  console.error("❌ FATAL: Missing required environment variables:");
  missingVars.forEach((varName) => console.error(`   - ${varName}`));
  console.error("Please set these variables before starting the server.");
  process.exit(1);
}
console.log("✅ All required environment variables are set");

const app = express();
const httpServer = createServer(app);

// ✅ RAILWAY: Trust proxy for correct IP detection behind reverse proxy
// Without this, rate limiting will treat all users as same IP
app.set("trust proxy", 1);

// Initialize Socket.io
initializeSocket(httpServer).catch((error) => {
  console.error("Socket initialization failed:", error);
});

// ==========================================
// ✅ UNCAUGHT EXCEPTION HANDLERS
// ==========================================

// Track consecutive errors to detect crash loops
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
const ERROR_RESET_INTERVAL = 60000; // Reset counter after 1 minute of stability

// Reset error counter periodically if no issues
setInterval(() => {
  if (consecutiveErrors > 0) {
    console.log(`[Stability] Resetting error counter (was ${consecutiveErrors})`);
    consecutiveErrors = 0;
  }
}, ERROR_RESET_INTERVAL);

// Check if error is transient and shouldn't cause exit
const isTransientError = (error: Error | any): boolean => {
  const msg = error?.message?.toLowerCase() || "";
  const code = error?.code?.toLowerCase() || "";
  
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("etimedout") ||
    msg.includes("connection timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    code === "etimedout" ||
    code === "econnreset"
  );
};

process.on("uncaughtException", async (error) => {
  console.error("❌ UNCAUGHT EXCEPTION:", error);
  consecutiveErrors++;

  // Don't exit for transient errors
  if (isTransientError(error)) {
    console.warn("⚠️ Transient error - NOT exiting process");
    return;
  }

  // Try to log (fire and forget - don't await)
  import("./utils/emailService.js")
    .then(({ logError }) =>
      logError({
        message: `Uncaught Exception: ${error.message}`,
        source: "system",
        severity: "critical",
        errorCode: "UNCAUGHT_EXCEPTION",
        stack: error.stack,
      })
    )
    .catch((logErr) => console.error("Failed to log uncaught exception:", logErr));

  // Only exit if we've had too many consecutive errors (crash loop)
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error(`❌ FATAL: ${MAX_CONSECUTIVE_ERRORS} consecutive errors - exiting`);
    setTimeout(() => process.exit(1), 1000);
  } else {
    console.warn(`⚠️ Error ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} - continuing...`);
  }
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ UNHANDLED REJECTION at:", promise, "reason:", reason);
  
  // Don't exit on unhandled rejections - just log them
  // Most are transient network issues or rate limits
  
  // Fire and forget logging
  import("./utils/emailService.js")
    .then(({ logError }) =>
      logError({
        message: `Unhandled Rejection: ${reason}`,
        source: "system",
        severity: "high", // Downgraded from critical
        errorCode: "UNHANDLED_REJECTION",
        stack: reason instanceof Error ? reason.stack : String(reason),
      })
    )
    .catch((logErr) => console.error("Failed to log unhandled rejection:", logErr));
});

// Connect to database (with retry logic)
connectDB();

// ✅ SECURITY: Helmet for security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to load
}));

const isDev = process.env.NODE_ENV !== 'production';

// ✅ SECURITY: Rate limiting - Global (std: 200/15min)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 1000 : 200, // Relaxed in dev, standard in production
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ✅ SECURITY: Strict rate limit for auth routes (std: 5-10/15min)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 100 : 10, // 100 in dev for testing, 10 in production
  message: { message: "Too many login attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ✅ SECURITY: Strict rate limit for sensitive operations (orders, payments)
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 200 : 30, // Relaxed in dev, strict in production
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ✅ SECURITY: CORS - Restrict to allowed origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(",") 
  : [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8081",
      "https://www.heeszo.com",
      "https://heeszo.com",
    ];

app.use(cors({
  origin: process.env.NODE_ENV === "production" 
    ? allowedOrigins 
    : "*", // Allow all in development
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" })); // Limit payload size
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ✅ SECURITY: Prevent NoSQL injection attacks
// Sanitizes user input to prevent queries like {"$gt": ""} from bypassing auth
app.use(mongoSanitize());

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Register Routes (with auth rate limiting)
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/images", imagePostRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/chat", chatRoutes); // ✅ CHAT ROUTES
app.use("/api/ads", adRoutes);    // ✅ AD ROUTES
app.use("/api/orders", sensitiveLimiter, orderRoutes); // ✅ ORDER ROUTES (rate limited)
app.use("/api/compliance", complianceRoutes); // ✅ COMPLIANCE ROUTES
app.use("/api/notifications", notificationRoutes); // ✅ NOTIFICATION ROUTES
app.use("/api/search", searchRoutes); // ✅ SEARCH ROUTES
app.use("/api/contact", contactRoutes); // ✅ CONTACT ROUTES
app.use("/api/legal", legalRoutes); // ✅ LEGAL ROUTES
app.use("/api/addresses", addressRoutes); // ✅ SAVED ADDRESS ROUTES

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Redis health check endpoint
app.get("/health/redis", async (req, res) => {
  try {
    const client = await getRedisCommandClient();
    const pong = await client.ping();
    res.status(200).json({
      status: "ok",
      redis: "connected",
      ping: pong,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({
      status: "error",
      redis: "disconnected",
      message: error?.message || "Redis connection failed",
      timestamp: new Date().toISOString(),
    });
  }
});

// Error handling (must be after routes)
app.use(notFoundHandler);
app.use(errorHandler);

const PORT: number = parseInt(process.env.PORT || "5000", 10);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Socket.io enabled`);
  
  // ✅ Initialize background tag generation worker
  initializeTagWorker();
  
});
