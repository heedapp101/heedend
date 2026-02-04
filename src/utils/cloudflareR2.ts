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