import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface TagQueueJob {
  postId: string;
  imageUrl: string;
}

let _tagQueueConnection: Redis | null = null;
let _tagQueue: Queue<TagQueueJob> | null = null;

function getTagQueueConnection(): Redis {
  if (!_tagQueueConnection) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    _tagQueueConnection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _tagQueueConnection.on("error", (err: Error) => {
      console.error("Tag queue Redis connection error:", err);
    });
  }
  return _tagQueueConnection;
}

function getTagQueue(): Queue<TagQueueJob> {
  if (!_tagQueue) {
    _tagQueue = new Queue<TagQueueJob>("tag-generation", {
      connection: getTagQueueConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 100,
      },
    });
  }
  return _tagQueue;
}

export { getTagQueueConnection as tagQueueConnection };

export const tagQueue = {
  add: (...args: Parameters<Queue<TagQueueJob>['add']>) => getTagQueue().add(...args),
  getJobCounts: (...args: Parameters<Queue<TagQueueJob>['getJobCounts']>) => getTagQueue().getJobCounts(...args),
};

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
