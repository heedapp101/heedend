// src/workers/tagWorker.ts
/**
 * Background Worker for Tag Generation
 * 
 * This worker automatically starts when the server boots and processes
 * the tag queue continuously in the background.
 * 
 * No manual intervention needed - the queue starts processing automatically
 * when posts are added via queueTagGeneration().
 */

import { tagQueue } from "../utils/tagQueue.js";

/**
 * Initialize the tag generation worker
 * Called once when server starts
 */
export function initializeTagWorker() {
  console.log("🚀 Tag Generation Worker initialized");
  console.log("📋 Queue will process automatically when posts are added");
  
  // Log queue status every 5 minutes
  setInterval(() => {
    const status = tagQueue.getStatus();
    if (status.queueLength > 0 || status.processing) {
      console.log(`📊 Tag Queue Status: ${status.queueLength} items, Processing: ${status.processing}`);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// For manual testing/debugging
export { tagQueue };
