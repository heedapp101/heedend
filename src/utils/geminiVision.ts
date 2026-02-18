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

const logGeminiVisionError = async (
  message: string,
  errorCode: string,
  metadata: Record<string, any>,
  stack?: string,
  statusCode?: number,
  severity: "low" | "medium" | "high" | "critical" = "medium"
) => {
  try {
    const { logError } = await import("./emailService.js");
    await logError({
      message,
      source: "gemini-vision",
      severity,
      errorCode,
      endpoint: "/workers/tag-generation",
      method: "WORKER",
      metadata,
      stack,
      statusCode,
    });
  } catch (logErr) {
    console.error("Failed to log Gemini compliance error:", logErr);
  }
};

/**
 * Build a category-specific detail prompt for PASS 2.
 * Each category gets tailored tagging instructions so Gemini
 * knows exactly what attributes to extract.
 */
function buildDetailPrompt(category: string): string {
  const categoryPrompts: Record<string, string> = {
    "comic book": `This image is a COMIC BOOK. Generate tags describing the comic itself.
Include: title (if readable on cover), publisher (Marvel, DC, Image, manga publisher, etc.), series name, issue number if visible, genre (action, horror, romance, sci-fi, superhero, manga, etc.), character names if recognizable, era/decade, format (single issue, graphic novel, manga volume, trade paperback), condition if visible (new, vintage, used), art style.
Do NOT tag clothing worn by characters. Tag the COMIC BOOK as a product.`,

    "book": `This image is a BOOK. Generate tags describing the book itself.
Include: title (if readable), author (if visible), genre (fiction, non-fiction, textbook, self-help, etc.), format (hardcover, paperback, ebook), language if identifiable, series name, edition, condition, subject matter.
Do NOT describe people on the cover. Tag the BOOK as a product.`,

    "clothing": `This image is CLOTHING. Generate tags describing the garment.
Include: garment type (saree, kurta, lehenga, jeans, t-shirt, dress, palazzo, salwar, dupatta, hoodie, jacket, etc.), colors, patterns or embellishments, material if visible (silk, cotton, polyester, denim, etc.), cut/shape (sleeve type, neckline, length), style/occasion (casual, formal, traditional, festive, streetwear, etc.).
Do NOT mention people, age, body, or gender.`,

    "footwear": `This image is FOOTWEAR. Generate tags describing the shoes/sandals.
Include: type (sneakers, heels, boots, sandals, flats, loafers, kolhapuri, juttis, etc.), brand if visible, color, material (leather, canvas, suede, rubber), style (casual, formal, sports, ethnic), closure type (laces, velcro, slip-on, buckle), sole type.`,

    "electronics": `This image is an ELECTRONICS product. Generate tags describing the device.
Include: device type (laptop, phone, tablet, headphones, camera, TV, speaker, etc.), brand if visible, model if readable, color, storage/size if visible, condition (new, used, refurbished), key features visible.`,

    "hotel room": `This image is a HOTEL ROOM / ACCOMMODATION. Generate tags describing the room.
Include: room type (single, double, suite, deluxe, dormitory, villa, etc.), bed type (king, queen, twin, bunk), amenities visible (AC, TV, balcony, minibar, pool view, etc.), style (modern, traditional, rustic, luxury, budget), view if visible (ocean, mountain, city, garden).`,

    "furniture": `This image is FURNITURE. Generate tags describing the piece.
Include: type (sofa, table, chair, bed frame, wardrobe, shelf, desk, etc.), material (wood, metal, glass, fabric, rattan, etc.), color, style (modern, vintage, industrial, minimalist, traditional), size category (compact, full-size, king), intended room (living room, bedroom, office, outdoor).`,

    "jewelry": `This image is JEWELRY. Generate tags describing the piece.
Include: type (necklace, ring, earrings, bracelet, bangle, anklet, nose pin, maang tikka, etc.), metal (gold, silver, platinum, brass, artificial), stones if visible (diamond, ruby, pearl, kundan, etc.), style (traditional, modern, bridal, daily wear, statement), occasion.`,

    "art": `This image is ART / ARTWORK. Generate tags describing the artwork.
Include: medium (oil painting, watercolor, digital, sketch, print, sculpture, photography), style (abstract, realism, impressionism, pop art, folk art, etc.), subject (landscape, portrait, still life, abstract, etc.), color palette, size category if apparent, frame type if visible.`,

    "vehicle": `This image is a VEHICLE. Generate tags describing it.
Include: type (car, motorcycle, bicycle, scooter, truck, etc.), make/brand if visible, model if identifiable, color, fuel type if known, year/era if apparent, condition (new, used), body style (sedan, SUV, hatchback, cruiser, sport).`,

    "food": `This image is FOOD / BEVERAGE. Generate tags describing it.
Include: cuisine type (Indian, Italian, Chinese, etc.), dish name if identifiable, category (appetizer, main course, dessert, snack, beverage), dietary info (vegetarian, vegan, gluten-free if apparent), key ingredients visible, serving style (plated, takeaway, homemade).`,

    "toy": `This image is a TOY / GAME. Generate tags describing it.
Include: type (action figure, board game, puzzle, doll, building set, RC vehicle, plush, etc.), brand if visible (LEGO, Hot Wheels, Barbie, etc.), age range if indicated, theme, character/franchise, condition (new, used, vintage), material.`,

    "cosmetics": `This image is a COSMETICS / BEAUTY product. Generate tags describing it.
Include: product type (lipstick, foundation, serum, shampoo, perfume, etc.), brand if visible, shade/color, skin type if indicated, size, category (skincare, makeup, haircare, fragrance), key ingredients if readable.`,

    "bag": `This image is a BAG / LUGGAGE. Generate tags describing it.
Include: type (handbag, backpack, tote, clutch, suitcase, duffle, sling, etc.), brand if visible, material (leather, canvas, nylon, jute, etc.), color, size, style (casual, formal, travel, ethnic), closure type.`,

    "watch": `This image is a WATCH. Generate tags describing it.
Include: type (analog, digital, smartwatch), brand if visible, material (steel, leather, rubber, gold), dial color, style (casual, dress, sport, luxury), features if visible (chronograph, date, waterproof), strap type.`,

    "sports equipment": `This image is SPORTS EQUIPMENT. Generate tags describing it.
Include: sport (cricket, football, tennis, gym, yoga, etc.), equipment type (bat, ball, racket, weights, mat, etc.), brand if visible, material, size, condition, level (professional, amateur, beginner).`,

    "home decor": `This image is HOME DECOR. Generate tags describing it.
Include: type (vase, lamp, wall art, mirror, cushion, rug, candle, clock, etc.), material, color, style (modern, bohemian, minimalist, vintage, ethnic), size/dimensions category, room suitability.`,

    "musical instrument": `This image is a MUSICAL INSTRUMENT. Generate tags describing it.
Include: instrument type (guitar, piano, tabla, sitar, flute, drums, violin, etc.), brand if visible, material (wood type, metal, etc.), condition, level (beginner, professional), acoustic/electric, accessories included if visible.`,

    "kitchenware": `This image is KITCHENWARE / COOKWARE. Generate tags describing it.
Include: type (pan, pot, knife set, blender, mixer, plate set, etc.), material (stainless steel, cast iron, ceramic, glass, etc.), brand if visible, capacity/size, color, purpose (cooking, baking, serving, storage).`,

    "stationery": `This image is STATIONERY / OFFICE SUPPLIES. Generate tags describing it.
Include: type (notebook, pen, planner, art supplies, desk organizer, etc.), brand if visible, material, size, style, purpose (school, office, art, journaling), quantity if a set.`,

    "collectible": `This image is a COLLECTIBLE. Generate tags describing it.
Include: type (coin, stamp, card, figurine, antique, memorabilia, etc.), era/year, brand/franchise, condition (mint, used, vintage), rarity, material, authentication if visible, series.`,

    "eyewear": `This image is EYEWEAR. Generate tags describing it.
Include: type (sunglasses, prescription glasses, reading glasses, sports goggles), brand if visible, frame material (metal, plastic, acetate, wood), frame color, lens type (polarized, UV, blue light, tinted), shape (round, aviator, cat-eye, wayfarer, rectangle), style (casual, formal, sporty).`,

    "pet supplies": `This image is PET SUPPLIES. Generate tags describing the product.
Include: product type (food, toy, bed, collar, leash, grooming tool, etc.), target pet (dog, cat, bird, fish, etc.), brand if visible, size, material, special features.`,

    "garden supplies": `This image is a GARDEN / PLANT product. Generate tags describing it.
Include: type (plant, pot, seeds, tools, fertilizer, decor, etc.), plant name if identifiable, size, material of container, indoor/outdoor, care level if apparent.`,

    "tool": `This image is a TOOL / HARDWARE. Generate tags describing it.
Include: type (drill, wrench, saw, screwdriver set, measuring tape, etc.), brand if visible, power source (manual, electric, cordless, pneumatic), material, size, condition, purpose (woodworking, plumbing, electrical, general).`,
  };

  // Find matching category prompt or use generic
  const lowerCategory = category.toLowerCase();
  for (const [key, promptText] of Object.entries(categoryPrompts)) {
    if (lowerCategory.includes(key) || key.includes(lowerCategory)) {
      return `You are tagging a marketplace product image. The product category is: "${category}".

${promptText}

Return ONLY a JSON array of 6-12 short, lowercase tags.
The FIRST tag must be the product category "${category}".
No apologies, no sentences. If unclear, return [].`;
    }
  }

  // Generic fallback for unknown categories
  return `You are tagging a marketplace product image. The product category is: "${category}".

Generate tags that describe this ${category} in a way useful for search and discovery.
Include: type/subcategory, brand if visible, color, material, size/dimensions, condition, style, key features, and any identifying text readable on the product.

Return ONLY a JSON array of 6-12 short, lowercase tags.
The FIRST tag must be the product category "${category}".
Do NOT describe people, their bodies, age, or gender. Only describe the PRODUCT itself.
No apologies, no sentences. If unclear, return [].`;
}

/**
 * Ensure the category is present as the first tag
 */
function ensureCategoryTag(tags: string[], category: string): string[] {
  const lowerCategory = category.toLowerCase();
  const filtered = tags.filter((t) => t !== lowerCategory);
  return [lowerCategory, ...filtered].slice(0, 15);
}

/**
 * Two-pass product tagging using Gemini 2.0 Flash
 *
 * PASS 1 -> Send image to Gemini -> returns the general product category
 * PASS 2 -> Send image + category-specific prompt -> returns detailed tags
 *
 * This prevents cross-category confusion (e.g. tagging clothing on comic characters).
 * Supports any marketplace item: clothing, electronics, books, rooms, collectibles, etc.
 */
export const generateTagsFromImage = async (buffer: Buffer): Promise<string[]> => {
  if (!process.env.GEMINI_API_KEY) {
    const missingKeyError = new Error("GEMINI_API_KEY is not configured");
    console.error("[ERROR] Gemini Vision Configuration Error:", missingKeyError.message);

    await logGeminiVisionError(
      "Gemini Vision Configuration Error: GEMINI_API_KEY is missing",
      "GEMINI_API_KEY_MISSING",
      { bufferSize: buffer.length },
      missingKeyError.stack,
      undefined,
      "high"
    );

    throw missingKeyError;
  }

  try {
    const model = getClient().getGenerativeModel({ model: "gemini-2.0-flash" });

    // Convert buffer to base64
    const base64Image = buffer.toString("base64");
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
      const normalizeQuotes = (value: string) =>
        value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

      const cleaned = normalizeQuotes(text).trim();
      if (!cleaned) return [];
      if (isRefusal(cleaned)) return [];

      const cleanTag = (tag: string) => {
        const trimmed = tag
          .trim()
          .replace(/^[\[\]\(\)\{\}]+|[\[\]\(\)\{\}]+$/g, "")
          .replace(/^["']+|["']+$/g, "")
          .replace(/^\d+\s*[\.\)\-:]\s*/g, "")
          .replace(/^[-•*]\s*/g, "")
          .trim();
        return trimmed;
      };

      const extractQuoted = (value: string) => {
        const results: string[] = [];
        const doubleQuoted = value.matchAll(/"([^"]+)"/g);
        for (const match of doubleQuoted) {
          if (match[1]) results.push(match[1]);
        }
        const singleQuoted = value.matchAll(/'([^']+)'/g);
        for (const match of singleQuoted) {
          if (match[1]) results.push(match[1]);
        }
        return results;
      };

      let tags: string[] = [];
      if (cleaned.startsWith("[")) {
        try {
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            tags = parsed.map((t) => String(t));
          }
        } catch {
          // fall through to other parsing strategies
        }
      }

      if (tags.length === 0) {
        const quoted = extractQuoted(cleaned);
        if (quoted.length > 0) {
          tags = quoted;
        }
      }

      if (tags.length === 0) {
        const normalized = cleaned.replace(/\r?\n+/g, ",");
        tags = normalized.split(/[,\|]/);
      }

      return tags
        .map((tag) => cleanTag(tag).toLowerCase())
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

    // ─────────────────────────────────────────────────
    // PASS 1: Identify the general product category
    // ─────────────────────────────────────────────────
    const categoryPrompt = `You are a product category classifier for a general marketplace.
Look at this image and identify WHAT the product is — not details, just the broad category.

Respond with ONLY a single short category label in lowercase. Examples:
- comic book
- clothing
- footwear
- electronics
- hotel room
- furniture
- jewelry
- art
- vehicle
- food
- toy
- book
- cosmetics
- sports equipment
- musical instrument
- home decor
- kitchenware
- stationery
- collectible
- pet supplies
- garden supplies
- tool
- bag
- watch
- eyewear

Do NOT describe the image. Do NOT return a sentence. Just the category label.
If you truly cannot identify, respond with: unknown`;

    const categoryResult = await model.generateContent([categoryPrompt, imagePart]);
    const categoryResponse = await categoryResult.response;
    const rawCategory = categoryResponse.text().trim().toLowerCase()
      .replace(/^["']+|["']+$/g, "")
      .replace(/\.$/, "")
      .trim();
    const category = rawCategory.length > 0 && rawCategory.length < 50 ? rawCategory : "unknown";

    console.log(`[PASS 1] Gemini identified category: "${category}"`);

    // ─────────────────────────────────────────────────
    // PASS 2: Detailed tagging based on that category
    // ─────────────────────────────────────────────────
    const detailPrompt = buildDetailPrompt(category);

    const primary = await generate(detailPrompt);

    if (primary.tags.length > 0) {
      const tagsWithCategory = ensureCategoryTag(primary.tags, category);
      console.log(
        `[PASS 2] Gemini generated ${tagsWithCategory.length} tags for "${category}":`,
        tagsWithCategory.join(", ")
      );
      return tagsWithCategory;
    }

    // Fallback: simpler prompt if detail pass returned nothing
    const fallbackPrompt = `The image shows a product in the "${category}" category.
Return ONLY a JSON array of 5-10 short, lowercase tags describing this ${category}.
Focus on attributes a buyer would search for. The first tag should be "${category}".
    No sentences, no apologies, no people-related terms. If unclear, return [].`;

    const fallback = await generate(fallbackPrompt);
    if (fallback.tags.length === 0) {
      const emptyResponseError = new Error(`Gemini returned no parsable tags for category "${category}"`);
      (emptyResponseError as Error & { code?: string }).code = "GEMINI_EMPTY_RESPONSE";
      throw emptyResponseError;
    }

    const fallbackWithCategory = ensureCategoryTag(fallback.tags, category);
    console.log(
      `[WARN] Gemini fallback tags (${fallbackWithCategory.length}):`,
      fallbackWithCategory.join(", ")
    );
    return fallbackWithCategory;
  } catch (error: any) {
    console.error("[ERROR] Gemini Vision API Error:", error);

    const errorCode = typeof error?.code === "string" ? error.code : "GEMINI_API_ERROR";
    await logGeminiVisionError(
      `Gemini Vision API Error: ${error?.message || String(error)}`,
      errorCode,
      {
        details: error?.details || error?.toString?.() || String(error),
        bufferSize: buffer.length,
      },
      error?.stack,
      typeof error?.status === "number" ? error.status : undefined
    );

    throw error;
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
