import mongoose from "mongoose";

// ==========================================
// ✅ DATABASE CONNECTION WITH RETRY LOGIC
// ==========================================
// Railway may restart containers if DB is slow to wake up
// Retry with exponential backoff instead of immediate exit
// ==========================================

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000; // 2 seconds

export const connectDB = async (retryCount = 0): Promise<void> => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI!);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    
    // Set up MongoDB error listeners
    mongoose.connection.on("error", async (err) => {
      console.error("MongoDB connection error:", err);
      try {
        const { logError } = await import("../utils/emailService.js");
        await logError({
          message: `MongoDB Connection Error: ${err.message}`,
          source: "mongodb",
          severity: "critical",
          errorCode: err.code || "MONGO_CONNECTION_ERROR",
          metadata: { host: conn.connection.host },
        });
      } catch (logErr) {
        console.error("Failed to log MongoDB error:", logErr);
      }
    });
    
    mongoose.connection.on("disconnected", async () => {
      console.warn("⚠️ MongoDB disconnected - attempting to reconnect...");
      try {
        const { logError } = await import("../utils/emailService.js");
        await logError({
          message: "MongoDB connection lost - attempting to reconnect",
          source: "mongodb",
          severity: "high",
          errorCode: "MONGO_DISCONNECTED",
        });
      } catch (logErr) {
        console.error("Failed to log MongoDB disconnect:", logErr);
      }
    });
    
    mongoose.connection.on("reconnected", () => {
      console.log("✅ MongoDB reconnected successfully");
    });
    
  } catch (error: any) {
    console.error(`❌ MongoDB Connection Error (attempt ${retryCount + 1}/${MAX_RETRIES}): ${error.message}`);
    
    if (retryCount < MAX_RETRIES - 1) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount); // Exponential backoff
      console.log(`⏳ Retrying in ${delay / 1000} seconds...`);
      
      await new Promise((resolve) => setTimeout(resolve, delay));
      return connectDB(retryCount + 1);
    }
    
    // Max retries exceeded - log and exit
    console.error(`❌ FATAL: Could not connect to MongoDB after ${MAX_RETRIES} attempts`);
    
    try {
      // Try to log via console since DB isn't connected
      console.error("Database connection failed permanently. Exiting...");
    } catch (logErr) {
      // Ignore
    }
    
    process.exit(1);
  }
};
