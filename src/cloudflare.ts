import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();

const s3 = new AWS.S3({
  endpoint: process.env.CF_ENDPOINT, // Cloudflare R2 endpoint
  accessKeyId: process.env.CF_ACCESS_KEY_ID,
  secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  signatureVersion: "v4",
  region: "auto", // R2 usually requires 'auto'
});

// ✅ New Function for Frontend "Smart Upload"
export const getPresignedUrl = async (folder: string, fileType: string) => {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  // Determine extension from fileType or default to .jpg
  const extension = fileType.split('/')[1] || 'jpg'; 
  const key = `${folder}/${uniqueId}.${extension}`;

  const params = {
    Bucket: process.env.CF_BUCKET_NAME!,
    Key: key,
    Expires: 60 * 5, // Link valid for 5 minutes
    ContentType: fileType,
    ACL: "public-read", 
  };

  try {
    const uploadUrl = await s3.getSignedUrlPromise("putObject", params);
    // Construct the public URL for storing in MongoDB
    const publicUrl = `${process.env.CF_PUBLIC_URL || process.env.CF_ENDPOINT}/${key}`; 
    return { uploadUrl, publicUrl };
  } catch (err) {
    console.error("Presigned URL Error:", err);
    throw new Error("Could not generate upload URL");
  }
};

export const uploadToR2 = async (key: string, buffer: Buffer, contentType: string) => {
  const params = {
    Bucket: process.env.CF_BUCKET_NAME!,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: "public-read", // optional, if you want public access
  };

  await s3.putObject(params).promise();

  return `${process.env.CF_ENDPOINT}/${key}`; // public URL
};