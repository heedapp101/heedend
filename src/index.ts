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
import { initializeTypesense } from "./services/typesenseSync.js"; // ✅ Typesense Search

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
initializeSocket(httpServer);

// ==========================================
// ✅ UNCAUGHT EXCEPTION HANDLERS
// ==========================================
process.on("uncaughtException", async (error) => {
  console.error("❌ UNCAUGHT EXCEPTION:", error);
  try {
    const { logError } = await import("./utils/emailService.js");
    await logError({
      message: `Uncaught Exception: ${error.message}`,
      source: "system",
      severity: "critical",
      errorCode: "UNCAUGHT_EXCEPTION",
      stack: error.stack,
    });
  } catch (logErr) {
    console.error("Failed to log uncaught exception:", logErr);
  }
  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ UNHANDLED REJECTION at:", promise, "reason:", reason);
  try {
    const { logError } = await import("./utils/emailService.js");
    await logError({
      message: `Unhandled Rejection: ${reason}`,
      source: "system",
      severity: "critical",
      errorCode: "UNHANDLED_REJECTION",
      stack: reason instanceof Error ? reason.stack : String(reason),
    });
  } catch (logErr) {
    console.error("Failed to log unhandled rejection:", logErr);
  }
});

// Connect to database (with retry logic)
connectDB();

// ✅ SECURITY: Helmet for security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to load
}));

// ✅ SECURITY: Rate limiting - Global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ✅ SECURITY: Strict rate limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Only 20 auth attempts per 15 minutes
  message: { message: "Too many login attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ✅ SECURITY: Strict rate limit for sensitive operations (orders, payments)
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per 15 minutes for orders/payments
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ✅ SECURITY: CORS - Restrict to allowed origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(",") 
  : ["http://localhost:3000", "http://localhost:5173", "http://localhost:8081"];

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

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
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
  
  // ✅ Initialize Typesense search (non-blocking, with fallback)
  initializeTypesense().then((available) => {
    if (available) {
      console.log("✅ Typesense search engine ready (~5ms searches)");
    } else {
      console.log("ℹ️ Using MongoDB for search (configure TYPESENSE_* env vars for faster search)");
    }
  });
});
