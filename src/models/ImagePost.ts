import mongoose, { Schema } from "mongoose";

const imageSchema = new Schema(
  {
    high: { type: String, required: true },
    grid: { type: String },
    low: { type: String, required: true },
    width: { type: Number },
    height: { type: Number },
  },
  { _id: false }
);

const imagePostSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    price: { type: Number, min: 0 },
    
    allowComments: { type: Boolean, default: true },
    allowLikes: { type: Boolean, default: true },
    
    images: { type: [imageSchema], required: true },

    // ✅ NEW: Tags field for AI labels
    tags: { type: [String], default: [] },

    // ✅ Tag Generation Status (for async queue processing)
    tagGenerationStatus: { 
      type: String, 
      enum: ["pending", "processing", "completed", "failed"], 
      default: "pending" 
    },
    tagGeneratedAt: { type: Date },
    tagGenerationError: { type: String },

    // ✅ View Counter
    views: { type: Number, default: 0 },
    
    // ✅ Track unique viewers (for accurate analytics)
    viewedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],

    likedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],

    // ✅ BOOSTING SYSTEM: For seller post promotion
    isBoosted: { type: Boolean, default: false },
    boostedAt: { type: Date },
    boostExpiresAt: { type: Date },
    boostViews: { type: Number, default: 0 }, // Track views while boosted

    // ✅ ARCHIVE SYSTEM: Allow users to hide posts without deleting
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
  },
  { timestamps: true }
);

// ✅ Indexes for faster feed/search queries
imagePostSchema.index({ tags: 1 });
imagePostSchema.index({ createdAt: -1 });

// ✅ TEXT INDEX: For optimized full-text search (like big apps)
// MongoDB text index supports stemming, stop words, and relevance scoring
imagePostSchema.index(
  { title: 'text', description: 'text', tags: 'text' },
  { 
    weights: { title: 10, tags: 5, description: 1 }, // Title matches ranked highest
    name: 'search_text_index'
  }
);

// ✅ SCALABILITY: Indexes for collaborative filtering & trending
imagePostSchema.index({ likedBy: 1 });              // Collaborative filtering queries
imagePostSchema.index({ viewedBy: 1 });             // Unique view tracking queries
imagePostSchema.index({ views: -1 });               // Trending/popular sort
imagePostSchema.index({ user: 1 });                 // Filter by user
imagePostSchema.index({ views: -1, createdAt: -1 }); // Compound: trending + recency
imagePostSchema.index({ tags: 1, createdAt: -1 });  // Compound: content + recency
imagePostSchema.index({ tags: 1, views: -1 });      // Compound: content + popularity

// ✅ BOOSTING: Indexes for efficient boosted post queries
imagePostSchema.index({ isBoosted: 1, boostExpiresAt: -1 }); // Active boosted posts
imagePostSchema.index({ isBoosted: 1, boostedAt: -1 });      // Recently boosted (King of Hill)

export default mongoose.model("ImagePost", imagePostSchema);
