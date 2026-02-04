import sharp from "sharp";
import { uploadFile } from "../utils/cloudflareR2.js";

/**
 * Processes an image buffer into high and low quality,
 * uploads both to Cloudflare, and returns the URLs.
 */
export const processImage = async (buffer: Buffer, filename: string) => {
  try {
    // Validate buffer
    if (!buffer || buffer.length === 0) {
      throw new Error("Invalid or empty image buffer");
    }

    console.log(`📷 [ProcessImage] Starting processing for: ${filename}, buffer size: ${buffer.length}`);

    // First, try to get image metadata to validate it's a proper image
    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
      console.log(`📷 [ProcessImage] Image metadata: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);
    } catch (metaError: any) {
      console.warn(`⚠️ [ProcessImage] Could not read metadata: ${metaError.message}`);
      // Continue anyway, sharp might still be able to process it
    }

    // HIGH QUALITY (WebP format for better compression)
    let highBuffer: Buffer;
    try {
      highBuffer = await sharp(buffer, { failOn: 'none' }) // Don't fail on truncated images
        .rotate() // Auto-rotate based on EXIF
        .webp({ quality: 80 })
        .toBuffer();
      console.log(`✅ [ProcessImage] High quality buffer created: ${highBuffer.length} bytes`);
    } catch (sharpError: any) {
      console.error(`❌ [ProcessImage] Sharp high quality error:`, sharpError.message);
      
      // Fallback: Try with more lenient options
      try {
        console.log(`⚠️ [ProcessImage] Trying fallback processing...`);
        highBuffer = await sharp(buffer, { failOn: 'none', limitInputPixels: false })
          .toFormat('webp', { quality: 80 })
          .toBuffer();
        console.log(`✅ [ProcessImage] Fallback high quality succeeded: ${highBuffer.length} bytes`);
      } catch (fallbackError: any) {
        console.error(`❌ [ProcessImage] Fallback also failed:`, fallbackError.message);
        throw new Error(`Failed to process image: ${sharpError.message}`);
      }
    }

    const highFile = {
      originalname: `${filename}-high.webp`,
      buffer: highBuffer,
      mimetype: "image/webp",
    } as Express.Multer.File;

    const highUpload = await uploadFile(highFile);
    console.log(`✅ [ProcessImage] High quality uploaded: ${highUpload.Location}`);

    // LOW QUALITY (WebP thumbnail for better compression)
    let lowBuffer: Buffer;
    try {
      lowBuffer = await sharp(buffer, { failOn: 'none' })
        .rotate() // Auto-rotate based on EXIF
        .resize({ width: 400, withoutEnlargement: true })
        .webp({ quality: 50 })
        .toBuffer();
      console.log(`✅ [ProcessImage] Low quality buffer created: ${lowBuffer.length} bytes`);
    } catch (sharpError: any) {
      console.error(`❌ [ProcessImage] Sharp low quality error:`, sharpError.message);
      
      // Fallback for low quality
      try {
        lowBuffer = await sharp(buffer, { failOn: 'none', limitInputPixels: false })
          .resize({ width: 400, withoutEnlargement: true })
          .toFormat('webp', { quality: 50 })
          .toBuffer();
        console.log(`✅ [ProcessImage] Fallback low quality succeeded: ${lowBuffer.length} bytes`);
      } catch (fallbackError: any) {
        // If low quality fails, just use the high quality as both
        console.warn(`⚠️ [ProcessImage] Using high quality as low quality fallback`);
        lowBuffer = highBuffer;
      }
    }

    const lowFile = {
      originalname: `${filename}-low.webp`,
      buffer: lowBuffer,
      mimetype: "image/webp",
    } as Express.Multer.File;

    const lowUpload = await uploadFile(lowFile);
    console.log(`✅ [ProcessImage] Low quality uploaded: ${lowUpload.Location}`);

    return {
      high: highUpload.Location,
      low: lowUpload.Location,
    };
  } catch (error: any) {
    console.error(`❌ [ProcessImage] Fatal error:`, error.message);
    throw error;
  }
};
