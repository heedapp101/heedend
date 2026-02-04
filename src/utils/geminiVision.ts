// src/utils/geminiVision.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

// Lazy initialization to ensure env vars are loaded
let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
  }
  return genAI;
}

/**
 * Generate fashion-specific tags from image using Gemini 2.0 Flash
 * Cost: ~$0.01 per 1000 images
 * Returns culturally-aware tags like "saree", "kurta", "lehenga"
 */
export const generateTagsFromImage = async (buffer: Buffer): Promise<string[]> => {
  try {
    // Validate API key
    if (!process.env.GEMINI_API_KEY) {
      console.warn("⚠️ GEMINI_API_KEY not found, skipping tag generation");
      return [];
    }

    const model = getClient().getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const prompt = `Analyze this product image for an e-commerce platform and provide specific, searchable tags.

Focus on:
- SPECIFIC clothing types (saree, kurta, lehenga, jeans, t-shirt, dress, palazzo, salwar, dupatta, etc.)
- Colors (red, blue, black, multicolor, etc.)
- Patterns (floral, striped, embroidered, plain, printed, etc.)
- Style & occasion (casual, formal, traditional, ethnic, western, party wear, festive, bridal, etc.)
- Materials if visible (cotton, silk, denim, chiffon, etc.)
- Gender/category (women's wear, men's wear, unisex, kids, etc.)

Requirements:
- Return 8-12 relevant tags
- Use lowercase
- Focus on Indian fashion terms when applicable
- Be specific, not generic (prefer "red silk saree" over "clothing")
- Include both English and commonly used terms

Format: Return ONLY comma-separated tags, nothing else.
Example: red saree, silk, traditional wear, ethnic clothing, festive, embroidered, women's clothing, indian wear`;

    // Convert buffer to base64
    const base64Image = buffer.toString("base64");
    
    // Detect mime type from buffer
    const mimeType = detectMimeType(buffer);

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: mimeType,
      },
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    
    // Parse comma-separated tags
    const tags = text
      .split(",")
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag.length > 0 && tag.length < 50) // Filter valid tags
      .slice(0, 15); // Max 15 tags
    
    console.log(`✅ Gemini generated ${tags.length} tags:`, tags.join(", "));
    return tags;
    
  } catch (error: any) {
    console.error("❌ Gemini Vision API Error:", error);
    
    // Log to compliance system
    try {
      const { logError } = await import("./emailService.js");
      await logError({
        message: `Gemini Vision API Error: ${error.message}`,
        source: "gemini-vision",
        severity: "medium",
        errorCode: error.code || "GEMINI_API_ERROR",
        metadata: {
          details: error.details || error.toString(),
          bufferSize: buffer.length,
        },
      });
    } catch (logErr) {
      console.error("Failed to log error:", logErr);
    }
    
    return []; // Return empty array on failure
  }
};

/**
 * Detect MIME type from buffer magic numbers
 */
function detectMimeType(buffer: Buffer): string {
  // Check magic numbers (first few bytes)
  const magicNumbers = buffer.toString("hex", 0, 4);
  
  if (magicNumbers.startsWith("ffd8ff")) return "image/jpeg";
  if (magicNumbers.startsWith("89504e47")) return "image/png";
  if (magicNumbers.startsWith("47494638")) return "image/gif";
  if (magicNumbers.startsWith("52494646")) return "image/webp";
  
  // Default to JPEG (most common)
  return "image/jpeg";
}
