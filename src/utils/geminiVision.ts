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
 * Generate garment-specific tags from image using Gemini 2.0 Flash
 * Cost: ~$0.01 per 1000 images
 * Returns culturally-aware tags like "saree", "kurta", "lehenga"
 */
export const generateTagsFromImage = async (buffer: Buffer): Promise<string[]> => {
  try {
    // Validate API key
    if (!process.env.GEMINI_API_KEY) {
      console.warn("[WARN] GEMINI_API_KEY not found, skipping tag generation");
      return [];
    }

    const model = getClient().getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `You are labeling a product-only clothing image for an e-commerce catalog.
Return ONLY a JSON array of 6-12 short, lowercase tags.

Tags must describe visible garment attributes only:
- item type (saree, kurta, lehenga, jeans, t-shirt, dress, palazzo, salwar, dupatta, etc.)
- colors
- patterns or embellishments
- materials if visible
- cut/shape details if visible (sleeve, neckline, length)
- style/occasion (casual, formal, traditional, festive, etc.)

Do NOT mention people, age, body, or infer gender. No apologies, no sentences.
If unclear, return [].

Example: ["red saree", "silk", "embroidered", "gold border", "traditional"]`;

    const fallbackPrompt = `Return ONLY a JSON array of 5-10 short, lowercase tags describing the garment in the image.
Include item type, colors, pattern/embellishment, and material if visible.
No sentences, no apologies, no people-related terms. If unclear, return [].`;

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

    const isRefusal = (text: string) => {
      const lower = text.toLowerCase();
      const markers = [
        "i'm sorry",
        "i am sorry",
        "cannot",
        "can't",
        "unable",
        "not able",
        "i won't",
        "refuse",
        "not allowed",
        "policy",
      ];
      return markers.some((m) => lower.includes(m));
    };

    const parseTags = (text: string): string[] => {
      const cleaned = text.trim();
      if (!cleaned) return [];
      if (isRefusal(cleaned)) return [];

      let tags: string[] = [];
      if (cleaned.startsWith("[")) {
        try {
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            tags = parsed.map((t) => String(t));
          }
        } catch {
          // fall through to comma parsing
        }
      }

      if (tags.length === 0) {
        tags = cleaned.split(",");
      }

      return tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length < 50)
        .slice(0, 15);
    };

    const generate = async (inputPrompt: string) => {
      const result = await model.generateContent([inputPrompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      const tags = parseTags(text);
      return { text, tags };
    };

    const primary = await generate(prompt);
    if (primary.tags.length > 0) {
      console.log(
        `[OK] Gemini generated ${primary.tags.length} tags:`,
        primary.tags.join(", ")
      );
      return primary.tags;
    }

    const fallback = await generate(fallbackPrompt);
    console.log(
      `[WARN] Gemini fallback tags (${fallback.tags.length}):`,
      fallback.tags.join(", ")
    );
    return fallback.tags;
  } catch (error: any) {
    console.error("[ERROR] Gemini Vision API Error:", error);

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
