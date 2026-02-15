import AWS from "aws-sdk";
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

const s3 = new AWS.S3({
  endpoint: process.env.CF_ENDPOINT,
  accessKeyId: process.env.CF_ACCESS_KEY_ID,
  secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  signatureVersion: "v4",
  region: "auto", // Required for Cloudflare R2
});

// Export S3 client for use in other modules (like document retrieval)
export { s3 };

// ✅ MODIFIED: Accept 'folder' argument (default to 'public')
export const uploadFile = async (file: Express.Multer.File, folder: string = "public") => {
  // ✅ FIX: Sanitize filename (remove spaces and special chars)
  // This converts "My File (1).pdf" -> "My-File-1.pdf"
  const sanitizedOriginalName = file.originalname
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/[^a-zA-Z0-9.\-_]/g, ""); // Remove anything that isn't a letter, number, dot, hyphen, or underscore

  // Key format: folder/timestamp-random-filename
  const fileKey = `${folder}/${Date.now()}-${Math.random()}-${sanitizedOriginalName}`;

  const params = {
    Bucket: process.env.CF_BUCKET_NAME!,
    Key: fileKey,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: "public, max-age=31536000, immutable", // ✅ NEW: Cache for 1 year (static content)
    // ACL: "public-read" // Optional: Enable if you want direct public access via R2 dev URL
  };

  try {
    const result = await s3.upload(params).promise();

    // Construct the URL. The Cloudflare Worker/Backend will intercept requests
    const publicUrl = `${process.env.CF_PUBLIC_URL}/${fileKey}`;

    return {
      ...result,
      Location: publicUrl 
    };
  } catch (err) {
    console.error("❌ [uploadFile] Cloudflare Upload Error:", err);
    console.error("  - Error message:", (err as any).message);
    console.error("  - Error code:", (err as any).code);
    console.error("  - Error name:", (err as any).name);
    
    // Log to compliance system
    try {
      const { logError } = await import("./emailService.js");
      await logError({
        message: `Cloudflare R2 Upload Error: ${(err as any).message}`,
        source: "cloudflare",
        severity: "high",
        errorCode: (err as any).code || "CF_UPLOAD_ERROR",
        metadata: {
          bucket: process.env.CF_BUCKET_NAME,
          folder,
          filename: file.originalname,
          fileSize: file.size,
        },
      });
    } catch (logErr) {
      console.error("Failed to log error:", logErr);
    }
    
    throw new Error("Failed to upload file to Cloudflare");
  }
};

/**
 * Delete a file from Cloudflare R2 by its public URL or key.
 * Accepts either a full URL (https://pub-xxx.r2.dev/public/...) or just the key ("public/...").
 */
export const deleteFile = async (urlOrKey: string): Promise<boolean> => {
  try {
    if (!urlOrKey) return false;

    // Extract key from full URL if needed
    let key = urlOrKey;
    const publicUrl = process.env.CF_PUBLIC_URL;
    if (publicUrl && urlOrKey.startsWith(publicUrl)) {
      key = urlOrKey.replace(`${publicUrl}/`, "");
    }
    // Also handle if it starts with http
    if (key.startsWith("http")) {
      const url = new URL(key);
      key = url.pathname.replace(/^\//, "");
    }

    if (!key) return false;

    await s3.deleteObject({
      Bucket: process.env.CF_BUCKET_NAME!,
      Key: key,
    }).promise();

    return true;
  } catch (err) {
    console.error("❌ [deleteFile] Cloudflare R2 Delete Error:", (err as any).message);
    return false;
  }
};

/**
 * Delete multiple files from Cloudflare R2.
 * Returns the count of successfully deleted files.
 */
export const deleteFiles = async (urlsOrKeys: string[]): Promise<number> => {
  if (!urlsOrKeys.length) return 0;

  // R2 supports batch delete via deleteObjects (max 1000 per request)
  const publicUrl = process.env.CF_PUBLIC_URL;
  const keys = urlsOrKeys
    .filter(Boolean)
    .map((urlOrKey) => {
      let key = urlOrKey;
      if (publicUrl && urlOrKey.startsWith(publicUrl)) {
        key = urlOrKey.replace(`${publicUrl}/`, "");
      }
      if (key.startsWith("http")) {
        try { key = new URL(key).pathname.replace(/^\//, ""); } catch { return ""; }
      }
      return key;
    })
    .filter(Boolean);

  if (!keys.length) return 0;

  let deleted = 0;
  // Process in batches of 1000
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await s3.deleteObjects({
        Bucket: process.env.CF_BUCKET_NAME!,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }).promise();
      deleted += batch.length;
    } catch (err) {
      console.error(`❌ [deleteFiles] Batch delete error (batch ${i / 1000 + 1}):`, (err as any).message);
    }
  }

  return deleted;
};