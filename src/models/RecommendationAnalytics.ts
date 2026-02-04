import mongoose, { Schema, Document } from "mongoose";

export interface IRecommendationAnalytics extends Document {
  userId: mongoose.Types.ObjectId;
  postId: mongoose.Types.ObjectId;
  source: "recommended" | "explore" | "trending" | "search" | "profile";
  action: "view" | "like" | "comment" | "save" | "skip";
  dwellTime?: number; // Time spent viewing the post in seconds
  clickedAt: Date;
  sessionId?: string;
  deviceType?: string;
}

const RecommendationAnalyticsSchema = new Schema<IRecommendationAnalytics>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    postId: {
      type: Schema.Types.ObjectId,
      ref: "ImagePost",
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ["recommended", "explore", "trending", "search", "profile"],
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ["view", "like", "comment", "save", "skip"],
      required: true,
      index: true,
    },
    dwellTime: {
      type: Number,
      default: 0,
    },
    clickedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    sessionId: {
      type: String,
    },
    deviceType: {
      type: String,
    },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
RecommendationAnalyticsSchema.index({ userId: 1, clickedAt: -1 });
RecommendationAnalyticsSchema.index({ source: 1, action: 1, clickedAt: -1 });

export default mongoose.model<IRecommendationAnalytics>(
  "RecommendationAnalytics",
  RecommendationAnalyticsSchema
);
