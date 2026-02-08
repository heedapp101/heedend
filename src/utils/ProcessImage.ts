import sharp from "sharp";
import { uploadFile } from "../utils/cloudflareR2.js";

const GRID_WIDTH = 900; // Optimized for 2-column mobile feed
const LOW_WIDTH = 400;
const HIGH_QUALITY = 80;
const GRID_QUALITY = 70;
const LOW_QUALITY = 50;

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

    // First, get image metadata (after orientation) to capture true dimensions
    let width: number | undefined;
    let height: number | undefined;
    try {
      const metadata = await sharp(buffer, { failOn: "none" }).rotate().metadata();
      width = metadata.width;
      height = metadata.height;
      console.log(`📷 [ProcessImage] Image metadata: ${width}x${height}, format: ${metadata.format}`);
    } catch (metaError: any) {
      console.warn(`⚠️ [ProcessImage] Could not read metadata: ${metaError.message}`);
      // Continue anyway, sharp might still be able to process it
    }

    // HIGH QUALITY (WebP format for better compression)
    let highBuffer: Buffer;
    try {
      highBuffer = await sharp(buffer, { failOn: "none" }) // Don't fail on truncated images
        .rotate() // Auto-rotate based on EXIF
        .webp({ quality: HIGH_QUALITY })
        .toBuffer();
      console.log(`✅ [ProcessImage] High quality buffer created: ${highBuffer.length} bytes`);
    } catch (sharpError: any) {
      console.error(`❌ [ProcessImage] Sharp high quality error:`, sharpError.message);
      
      // Fallback: Try with more lenient options
      try {
        console.log(`⚠️ [ProcessImage] Trying fallback processing...`);
        highBuffer = await sharp(buffer, { failOn: "none", limitInputPixels: false })
          .toFormat("webp", { quality: HIGH_QUALITY })
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

    // GRID QUALITY (Optimized for feed/grid)
    let gridBuffer: Buffer;
    try {
      gridBuffer = await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({ width: GRID_WIDTH, withoutEnlargement: true })
        .webp({ quality: GRID_QUALITY })
        .toBuffer();
      console.log(`✅ [ProcessImage] Grid buffer created: ${gridBuffer.length} bytes`);
    } catch (sharpError: any) {
      console.error(`❌ [ProcessImage] Sharp grid error:`, sharpError.message);
      try {
        gridBuffer = await sharp(buffer, { failOn: "none", limitInputPixels: false })
          .rotate()
          .resize({ width: GRID_WIDTH, withoutEnlargement: true })
          .toFormat("webp", { quality: GRID_QUALITY })
          .toBuffer();
        console.log(`✅ [ProcessImage] Fallback grid succeeded: ${gridBuffer.length} bytes`);
      } catch (fallbackError: any) {
        console.warn(`⚠️ [ProcessImage] Using high quality as grid fallback`);
        gridBuffer = highBuffer;
      }
    }

    const gridFile = {
      originalname: `${filename}-grid.webp`,
      buffer: gridBuffer,
      mimetype: "image/webp",
    } as Express.Multer.File;

    const gridUpload = gridBuffer === highBuffer
      ? highUpload
      : await uploadFile(gridFile);
    console.log(`✅ [ProcessImage] Grid quality uploaded: ${gridUpload.Location}`);

    // LOW QUALITY (WebP thumbnail for better compression)
    let lowBuffer: Buffer;
    try {
      lowBuffer = await sharp(buffer, { failOn: "none" })
        .rotate() // Auto-rotate based on EXIF
        .resize({ width: LOW_WIDTH, withoutEnlargement: true })
        .webp({ quality: LOW_QUALITY })
        .toBuffer();
      console.log(`✅ [ProcessImage] Low quality buffer created: ${lowBuffer.length} bytes`);
    } catch (sharpError: any) {
      console.error(`❌ [ProcessImage] Sharp low quality error:`, sharpError.message);
      
      // Fallback for low quality
      try {
        lowBuffer = await sharp(buffer, { failOn: "none", limitInputPixels: false })
          .rotate()
          .resize({ width: LOW_WIDTH, withoutEnlargement: true })
          .toFormat("webp", { quality: LOW_QUALITY })
          .toBuffer();
        console.log(`✅ [ProcessImage] Fallback low quality succeeded: ${lowBuffer.length} bytes`);
      } catch (fallbackError: any) {
        // If low quality fails, just use the high quality as both
        console.warn(`⚠️ [ProcessImage] Using grid quality as low quality fallback`);
        lowBuffer = gridBuffer || highBuffer;
      }
    }

    const lowFile = {
      originalname: `${filename}-low.webp`,
      buffer: lowBuffer,
      mimetype: "image/webp",
    } as Express.Multer.File;

    const lowUpload = lowBuffer === gridBuffer
      ? gridUpload
      : lowBuffer === highBuffer
        ? highUpload
        : await uploadFile(lowFile);
    console.log(`✅ [ProcessImage] Low quality uploaded: ${lowUpload.Location}`);

    return {
      high: highUpload.Location,
      grid: gridUpload.Location,
      low: lowUpload.Location,
      width,
      height,
    };
  } catch (error: any) {
    console.error(`❌ [ProcessImage] Fatal error:`, error.message);
    throw error;
  }
};
