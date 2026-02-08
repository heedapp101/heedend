// scripts/syncTypesense.ts
/**
 * Manually sync all data to Typesense
 * 
 * Usage:
 *   npx tsx scripts/syncTypesense.ts
 *   npx tsx scripts/syncTypesense.ts --posts-only
 *   npx tsx scripts/syncTypesense.ts --users-only
 */

import dotenv from "dotenv";
dotenv.config();

import { connectDB } from "../src/config/db.js";
import { 
  initializeTypesense, 
  fullSync, 
  syncAllPosts, 
  syncAllUsers, 
  syncAllTags 
} from "../src/services/typesenseSync.js";
import { isTypesenseAvailable } from "../src/config/typesense.js";

async function main() {
  console.log("🚀 Typesense Sync Script");
  console.log("========================\n");
  
  // Parse arguments
  const args = process.argv.slice(2);
  const postsOnly = args.includes("--posts-only");
  const usersOnly = args.includes("--users-only");
  const tagsOnly = args.includes("--tags-only");
  
  // Check Typesense availability
  const available = await isTypesenseAvailable();
  if (!available) {
    console.error("❌ Typesense is not available!");
    console.error("   Make sure TYPESENSE_HOST and TYPESENSE_API_KEY are set in .env");
    process.exit(1);
  }
  
  console.log("✅ Typesense is available\n");
  
  // Connect to MongoDB
  console.log("📦 Connecting to MongoDB...");
  await connectDB();
  console.log("");
  
  // Initialize Typesense collections
  console.log("📋 Initializing Typesense collections...");
  await initializeTypesense();
  console.log("");
  
  // Run sync
  const startTime = Date.now();
  
  if (postsOnly) {
    console.log("📝 Syncing posts only...\n");
    const result = await syncAllPosts();
    console.log("\n✅ Posts sync complete:", result);
  } else if (usersOnly) {
    console.log("👥 Syncing users only...\n");
    const result = await syncAllUsers();
    console.log("\n✅ Users sync complete:", result);
  } else if (tagsOnly) {
    console.log("🏷️ Syncing tags only...\n");
    const result = await syncAllTags();
    console.log("\n✅ Tags sync complete:", result);
  } else {
    console.log("🔄 Running full sync...\n");
    const result = await fullSync();
    console.log("\n✅ Full sync complete:");
    console.log("   Posts:", result.posts);
    console.log("   Users:", result.users);
    console.log("   Tags:", result.tags);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n⏱️ Total time: ${elapsed}s`);
  
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Sync failed:", error);
  process.exit(1);
});
