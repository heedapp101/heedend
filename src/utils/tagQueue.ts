// src/utils/tagQueue.ts
import ImagePost from "../models/ImagePost.js";
import { generateTagsFromImage } from "./geminiVision.js";

/**
 * In-memory queue for background tag processing
 * For production, consider using Redis Queue (Bull) or database-based queue
 */
interface TagQueueItem {
  postId: string;
  imageUrl: string;
  imageBuffer?: Buffer;
  retryCount: number;
}

class TagQueue {
  private queue: TagQueueItem[] = [];
  private processing = false;
  private maxRetries = 3;
  private processingInterval = 2000; // 2 seconds between batches
  private batchSize = 5; // Process 5 images at a time

  /**
   * Add a post to the tag generation queue
   */
  async addToQueue(postId: string, imageBuffer: Buffer, imageUrl: string) {
    this.queue.push({
      postId,
      imageUrl,
      imageBuffer,
      retryCount: 0,
    });

    console.log(`📋 Added post ${postId} to tag queue. Queue size: ${this.queue.length}`);

    // Start processing if not already running
    if (!this.processing) {
      this.startProcessing();
    }
  }

  /**
   * Start processing the queue
   */
  private async startProcessing() {
    if (this.processing) return;

    this.processing = true;
    console.log("🚀 Tag queue processing started");

    while (this.queue.length > 0) {
      // Get next batch
      const batch = this.queue.splice(0, this.batchSize);
      
      console.log(`⚙️ Processing batch of ${batch.length} items...`);

      // Process batch in parallel
      await Promise.all(
        batch.map(item => this.processItem(item))
      );

      // Wait before next batch to avoid rate limits
      if (this.queue.length > 0) {
        await this.sleep(this.processingInterval);
      }
    }

    this.processing = false;
    console.log("✅ Tag queue processing completed");
  }

  /**
   * Process a single queue item
   */
  private async processItem(item: TagQueueItem) {
    try {
      console.log(`🔄 Processing tags for post: ${item.postId}`);

      // Skip if no buffer (shouldn't happen)
      if (!item.imageBuffer) {
        console.warn(`⚠️ No image buffer for post ${item.postId}`);
        return;
      }

      // Generate tags using Gemini
      const tags = await generateTagsFromImage(item.imageBuffer);

      if (tags.length === 0) {
        console.warn(`⚠️ No tags generated for post ${item.postId}`);
      }

      // Update post in database
      await ImagePost.findByIdAndUpdate(
        item.postId,
        {
          $addToSet: { tags: { $each: tags } }, // Add tags without duplicates
          tagGenerationStatus: "completed",
          tagGeneratedAt: new Date(),
        },
        { new: true }
      );

      console.log(`✅ Updated post ${item.postId} with ${tags.length} tags:`, tags.join(", "));

    } catch (error: any) {
      console.error(`❌ Error processing post ${item.postId}:`, error.message);

      // Retry logic
      if (item.retryCount < this.maxRetries) {
        item.retryCount++;
        this.queue.push(item); // Re-add to queue
        console.log(`🔄 Retrying post ${item.postId} (attempt ${item.retryCount}/${this.maxRetries})`);
      } else {
        // Mark as failed after max retries
        try {
          await ImagePost.findByIdAndUpdate(item.postId, {
            tagGenerationStatus: "failed",
            tagGenerationError: error.message,
          });
          console.error(`❌ Failed to process post ${item.postId} after ${this.maxRetries} retries`);
        } catch (updateErr) {
          console.error(`❌ Failed to update error status for post ${item.postId}`);
        }
      }
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
    };
  }

  /**
   * Clear the queue (for testing/maintenance)
   */
  clearQueue() {
    this.queue = [];
    console.log("🗑️ Tag queue cleared");
  }
}

// Singleton instance
export const tagQueue = new TagQueue();

/**
 * Helper function to add post to tag queue
 */
export async function queueTagGeneration(
  postId: string,
  imageBuffer: Buffer,
  imageUrl: string
) {
  await tagQueue.addToQueue(postId, imageBuffer, imageUrl);
}

/**
 * Get queue status
 */
export function getTagQueueStatus() {
  return tagQueue.getStatus();
}
