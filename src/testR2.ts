import dotenv from "dotenv";
dotenv.config();
import AWS from "aws-sdk";
import fs from "fs";

const s3 = new AWS.S3({
  endpoint: process.env.CF_ENDPOINT,
  accessKeyId: process.env.CF_ACCESS_KEY_ID,
  secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
  signatureVersion: "v4",
});

const buffer = fs.readFileSync("test.jpg"); // small test image

const params = {
  Bucket: process.env.CF_BUCKET_NAME!,
  Key: `test-${Date.now()}.jpg`,
  Body: buffer,
  ContentType: "image/jpeg",
};

(async () => {
  try {
    const result = await s3.upload(params).promise();
    console.log("Upload success:", result.Location);
  } catch (err) {
    console.error("Upload failed:", err);
  }
})();
