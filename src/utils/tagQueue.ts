import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface TagQueueJob {
  postId: string;
  imageUrl: string;
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const tagQueueConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

tagQueueConnection.on("error", (err: Error) => {
  console.error("Tag queue Redis connection error:", err);
});

export const tagQueue = new Queue<TagQueueJob>("tag-generation", {
  connection: tagQueueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 100,
  },
});

/**
 * Helper function to add post to tag queue
 */
export async function queueTagGeneration(postId: string, imageUrl: string) {
  await tagQueue.add("generate-tags", { postId, imageUrl });
}

/**
 * Get queue status
 */
export async function getTagQueueStatus() {
  const counts = await tagQueue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "completed",
    "failed"
  );

  return {
    queueLength: counts.waiting + counts.delayed,
    processing: counts.active > 0,
    waiting: counts.waiting,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
  };
}
