import mongoose from "mongoose";
import User from "../models/User.js";

// Weights for different actions
export const INTEREST_WEIGHTS = {
  VIEW: 1,
  LIKE: 5,
  COMMENT: 8,
  SAVE: 10, // Highest intent - user wants to keep/reference this content
};

// Decay Factor (0.98 means 2% decay per interaction)
// This ensures old interests slowly drop off the top 25
const DECAY_FACTOR = 0.98;
const MAX_INTERESTS = 25;

/**
 * Updates user interests using Weighted Frequency + Decay Algorithm
 * 
 * The Algorithm:
 * 1. Score Accumulation: Every interaction adds points to the tag's score
 * 2. Global Decay: All existing scores are multiplied by decay factor (0.98)
 * 3. Ranking & Capping: Sort by score descending and keep only Top 50
 */
export const updateUserInterests = async (
  userId: mongoose.Types.ObjectId | string,
  tags: string[],
  weight: number
) => {
  if (!tags || tags.length === 0) return;

  try {
    const user = await User.findById(userId);
    if (!user) return;

    // 1. Normalize new tags
    const newTags = tags
      .filter((t) => t && typeof t === "string")
      .map((t) => t.trim().toLowerCase());

    if (newTags.length === 0) return;

    // 2. Map existing interests for fast lookup
    const interestMap = new Map<string, number>();

    // Apply Decay to ALL existing interests first
    // Handle both old format (string[]) and new format (IInterest[])
    if (user.interests && Array.isArray(user.interests)) {
      user.interests.forEach((interest: any) => {
        // Check if it's old format (plain string) or new format (object with tag/score)
        if (typeof interest === "string") {
          // Old format: migrate with a default score
          const tag = interest.trim().toLowerCase();
          if (tag) {
            interestMap.set(tag, 5 * DECAY_FACTOR); // Give existing interests a base score
          }
        } else if (interest && typeof interest === "object" && interest.tag) {
          // New format: apply decay
          const tag = interest.tag.trim().toLowerCase();
          const score = typeof interest.score === "number" ? interest.score : 5;
          if (tag) {
            interestMap.set(tag, score * DECAY_FACTOR);
          }
        }
      });
    }

    // 3. Add/Update Scores for new tags
    newTags.forEach((tag) => {
      const currentScore = interestMap.get(tag) || 0;
      interestMap.set(tag, currentScore + weight);
    });

    // 4. Convert back to array (filter out any empty tags)
    const updatedInterests = Array.from(interestMap.entries())
      .filter(([tag]) => tag && tag.length > 0)
      .map(([tag, score]) => ({
        tag,
        score,
        lastInteracted: new Date(),
      }));

    // 5. SORT & CAP (The Algorithm)
    // Sort by Score DESC. If scores equal, use most recent.
    updatedInterests.sort((a, b) => b.score - a.score);

    // Keep only Top 25 (Removes the "last" ones)
    const topInterests = updatedInterests.slice(0, MAX_INTERESTS);

    // 6. Save
    user.interests = topInterests as any;
    await user.save();
  } catch (err) {
    console.error("Error updating interests algo:", err);
  }
};
