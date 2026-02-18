import { Worker, QueueEvents } from "bullmq";
import ImagePost from "../models/ImagePost.js";
import { generateTagsFromImage } from "../utils/geminiVision.js";
import { tagQueueConnection } from "../utils/tagQueue.js";
import { logError } from "../utils/emailService.js";

const QUEUE_NAME = "tag-generation";

const fetchImageBuffer = async (imageUrl: string): Promise<Buffer> => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

let worker: Worker | null = null;

/**
 * Initialize the tag generation worker
 * Called once when server starts
 */
export function initializeTagWorker() {
  if (worker) return worker;

  console.log("Tag Generation Worker initialized");

  const workerConnection = tagQueueConnection().duplicate();
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { postId, imageUrl } = job.data as { postId: string; imageUrl: string };

      await ImagePost.findByIdAndUpdate(postId, {
        tagGenerationStatus: "processing",
      });

      try {
        const imageBuffer = await fetchImageBuffer(imageUrl);
        const tags = await generateTagsFromImage(imageBuffer);
        if (tags.length === 0) {
          throw new Error("Gemini generated no tags");
        }

        await ImagePost.findByIdAndUpdate(postId, {
          $addToSet: { tags: { $each: tags } },
          tagGenerationStatus: "completed",
          tagGeneratedAt: new Date(),
          tagGenerationError: undefined,
        });

        return { postId, tags, count: tags.length };
      } catch (error: any) {
        const attempts = job.opts.attempts ?? 1;
        const attemptsMade = job.attemptsMade + 1;
        const isFinalAttempt = attemptsMade >= attempts;
        const errorMessage = error?.message || String(error);

        if (isFinalAttempt) {
          await ImagePost.findByIdAndUpdate(postId, {
            tagGenerationStatus: "failed",
            tagGenerationError: errorMessage,
          });

          try {
            await logError({
              message: `Image tagging failed for post ${postId}: ${errorMessage}`,
              source: "feature",
              severity: "medium",
              errorCode: "IMAGE_TAGGING_FAILED",
              endpoint: "/workers/tag-generation",
              method: "WORKER",
              metadata: {
                feature: "image-tagging",
                postId,
                imageUrl,
                queueJobId: job.id,
                attemptsMade,
                maxAttempts: attempts,
              },
              stack: error?.stack,
            });
          } catch (logErr) {
            console.error("Failed to log image tagging failure:", logErr);
          }
        }

        throw error;
      }
    },
    { connection: workerConnection }
  );

  worker.on("completed", (job, result) => {
    if (result?.count !== undefined) {
      console.log(`Tag generation completed for ${job.id}: ${result.count} tags`);
    }
  });

  worker.on("failed", (job, err) => {
    console.error(`Tag generation failed for job ${job?.id}:`, err?.message || err);
  });

  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: tagQueueConnection().duplicate(),
  });

  queueEvents.on("error", (err) => {
    console.error("Tag queue events error:", err);
  });

  return worker;
}

export { tagQueueConnection };
