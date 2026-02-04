import AWS from "aws-sdk";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const s3 = new AWS.S3({
  endpoint: process.env.CF_ENDPOINT,
  accessKeyId: process.env.CF_ACCESS_KEY_ID,
  secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  signatureVersion: "v4",
  s3ForcePathStyle: true,     // ⭐ REQUIRED for Cloudflare R2
});

/**
 * Upload file to R2
 */
const uploadToR2 = async (key: string, buffer: Buffer, contentType: string) => {
  const params: AWS.S3.PutObjectRequest = {
    Bucket: process.env.CF_BUCKET_NAME!,   // non-null
    Key: key,
    Body: buffer,
    ContentType: contentType,
  };

  await s3.putObject(params).promise();

  return `${process.env.CF_ENDPOINT}/${process.env.CF_BUCKET_NAME}/${key}`;
};

(async () => {
  try {
    const buffer = fs.readFileSync("test-image.jpg");
    const url = await uploadToR2("test-image.jpg", buffer, "image/jpeg");

    console.log("✅ Upload successful!");
    console.log("File URL:", url);
  } catch (err) {
    console.error("❌ Upload failed:", err);
  }
})();
