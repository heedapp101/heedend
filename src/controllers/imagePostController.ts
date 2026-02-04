import { Request, Response } from "express";
import mongoose from "mongoose";
import ImagePost from "../models/ImagePost.js";
import Ad from "../models/Ad.js";
import RecommendationAnalytics from "../models/RecommendationAnalytics.js";
import Report from "../models/Report.js";
import { processImage } from "../utils/ProcessImage.js";
import { uploadFile } from "../utils/cloudflareR2.js";
import { queueTagGeneration } from "../utils/tagQueue.js"; 
import { AuthRequest } from "../middleware/authMiddleware.js";
import { INTEREST_WEIGHTS } from "../utils/interestUtils.js";
import { interestBuffer } from "../utils/InterestBuffer.js";
import { notifyLike } from "../utils/notificationService.js";

// Tag generation now happens asynchronously via queue system
// No blocklist needed - Gemini is prompted for specific fashion terms

/* =========================
   CREATE IMAGE POST
========================= */
export const createImagePost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    // 1. Extract inputs
    const { title, description } = req.body;
    const priceRaw = req.body.price;
    const userTagsRaw = req.body.tags;

    // --- Validation ---
    if (!title || !description) {
      return res.status(400).json({ message: "Title and description required" });
    }

    // --- Price Logic ---
    let parsedPrice: number | undefined = undefined;
    if (req.user.userType === "business" && priceRaw) {
      const num = Number(priceRaw);
      if (!isNaN(num)) parsedPrice = num;
    }

    if (req.user.userType === "general" && priceRaw !== undefined && priceRaw !== "") {
      return res.status(400).json({ message: "Price is only allowed for business users" });
    }

    // --- Files ---
    const files = Array.isArray(req.files)
      ? req.files
      : req.files
      ? Object.values(req.files).flat()
      : [];

    if (files.length === 0) return res.status(400).json({ message: "Images are required" });

    // ---------------------------------------------------------
    // ✅ STEP A: Initialize Set with User Tags
    // ---------------------------------------------------------
    const combinedTags = new Set<string>();

    if (userTagsRaw) {
      // Handle Multer: single tag is a string, multiple are an array
      const manualTags = Array.isArray(userTagsRaw) ? userTagsRaw : [userTagsRaw];
      
      manualTags.forEach((t: any) => {
        if (t && typeof t === 'string') {
          const sanitized = t.trim().toLowerCase();
          if (sanitized) {
            combinedTags.add(sanitized);
          }
        }
      });
    }

    // ---------------------------------------------------------
    // ✅ STEP B: Process Images (Upload Only - Fast!)
    // ---------------------------------------------------------
    const images: { high: string; low: string }[] = [];
    const imageBuffers: Buffer[] = []; // Store buffers for async tag generation

    for (const file of files) {
      const name = `${Date.now()}-${Math.random()}`;

      console.log(`📷 [CreatePost] Processing image: ${file.originalname}, size: ${file.buffer.length} bytes`);

      // Store buffer for async tag generation
      imageBuffers.push(file.buffer);

      // Try processing with Sharp, fallback to original upload if it fails
      let processed: { high: string; low: string };

      try {
        // Just upload - no AI processing during upload!
        processed = await processImage(file.buffer, name);
      } catch (processError: any) {
        console.warn(`⚠️ [CreatePost] Image processing failed, uploading original: ${processError.message}`);
        
        // Fallback: Upload original file without processing
        const fallbackUpload = await uploadFile(file, "public");
        processed = {
          high: fallbackUpload.Location,
          low: fallbackUpload.Location, // Use same URL for both if processing failed
        };
      }

      images.push({
        high: processed.high,
        low: processed.low,
      });
    }

    const finalTags = Array.from(combinedTags);

    // ---------------------------------------------------------
    // ✅ STEP C: Save to Database
    // ---------------------------------------------------------
    const allowComments = req.body.allowComments === "true";
    const allowLikes = req.body.allowLikes === "true";

    const post = await ImagePost.create({
      user: req.user._id,
      title,
      description,
      allowComments,
      allowLikes,
      price: parsedPrice,
      images,
      tags: finalTags,
      tagGenerationStatus: "pending", // Tags will be generated asynchronously
    });

    // ---------------------------------------------------------
    // ✅ STEP D: Queue Tag Generation (Async - Non-blocking!)
    // ---------------------------------------------------------
    // Add to queue for background processing - upload is already complete!
    if (imageBuffers.length > 0) {
      // Queue the first image for tag generation (or all if you want)
      queueTagGeneration(
        post._id.toString(),
        imageBuffers[0], // Use first image for tags
        images[0].high
      ).catch(err => {
        console.error("⚠️ Failed to queue tag generation:", err);
      });
      
      console.log(`📋 Post ${post._id} queued for tag generation`);
    }

    const populatedPost = await ImagePost.findById(post._id)
      .populate("user", "username userType");

    return res.status(201).json({
      ...populatedPost!.toObject(),
      likes: 0,
    });

  } catch (err: any) {
    console.error("❌ [CreatePost] Error:", err);
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    return res.status(500).json({ message: "Failed to create post" });
  }
};

/* =========================
   GET ALL POSTS (PAGINATED)
========================= */
export const getAllImagePosts = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const posts = await ImagePost.find()
      .populate("user", "username userType")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const formatted = posts.map(post => ({
      ...post,
      likes: (post as any).likedBy?.length || 0,
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch posts" });
  }
};

/* =========================
   GET SELLER STATS
========================= */
export const getSellerStats = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const userId = req.user._id;

    const totalPosts = await ImagePost.countDocuments({ user: userId });
    
    const posts = await ImagePost.find({ user: userId });
    const totalLikes = posts.reduce((acc, post) => acc + (post.likedBy?.length || 0), 0);

    const postGrowth = await ImagePost.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      totalPosts,
      totalLikes,
      totalOrders: 12, // Mock for UI
      revenue: 450,    // Mock for UI
      graphData: postGrowth.map(d => ({ date: d._id, count: d.count }))
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch seller stats" });
  }
};

/* =========================
   GET SINGLE IMAGE POST
========================= */
export const getSinglePost = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const source = req.query.source as string; // Track where user came from

    // First get the post to check if user already viewed
    let post = await ImagePost.findById(id).populate("user", "username userType name profilePic");
    if (!post) return res.status(404).json({ message: "Not found" });

    // ✅ UNIQUE VIEWS: Only count view if user hasn't viewed before
    // Anonymous users always count (can't track them)
    // Logged-in users only count once
    const userId = req.user?._id;
    const hasViewed = userId && post.viewedBy?.some(vid => vid.toString() === userId.toString());
    
    if (!hasViewed) {
      // Increment view and add to viewedBy if logged in
      const updateQuery: any = { $inc: { views: 1 } };
      if (userId) {
        updateQuery.$addToSet = { viewedBy: userId };
      }
      post = await ImagePost.findByIdAndUpdate(id, updateQuery, { new: true })
        .populate("user", "username userType name profilePic") as any;
    }

    // 🚀 BUFFERED: Add View Weight (Zero DB latency - batched every 30s)
    if (req.user && post.tags && post.tags.length > 0) {
      interestBuffer.add(req.user._id.toString(), post.tags, INTEREST_WEIGHTS.VIEW);
      
      // 📊 Track analytics if source is provided (fire-and-forget, no await)
      if (source && ["recommended", "explore", "trending", "search", "profile"].includes(source)) {
        RecommendationAnalytics.create({
          userId: req.user._id,
          postId: post._id,
          source: source as any,
          action: "view",
          clickedAt: new Date(),
        }).catch(err => console.error("Analytics tracking error:", err));
      }
    }

    res.json({
      ...post.toObject(),
      likes: post.likedBy?.length || 0,
    });
  } catch (err) {
    console.error("Get Post Error:", err);
    res.status(500).json({ message: "Failed to fetch post" });
  }
};

/* =========================
   TOGGLE LIKE
========================= */
export const toggleLikePost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const post = await ImagePost.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.allowLikes === false) {
      return res.status(403).json({ message: "Likes are disabled for this post" });
    }

    const userId = req.user._id.toString();
    const index = post.likedBy.findIndex((id) => id.toString() === userId);
    const source = req.query.source as string;

    if (index !== -1) {
      post.likedBy.splice(index, 1); // Unlike
    } else {
      post.likedBy.push(new mongoose.Types.ObjectId(userId)); // Like

      // 🚀 BUFFERED: Add Like Weight (batched every 30s)
      if (post.tags && post.tags.length > 0) {
        interestBuffer.add(req.user._id.toString(), post.tags, INTEREST_WEIGHTS.LIKE);
      }

      // 📊 Track analytics for likes (fire-and-forget, no await)
      if (source && ["recommended", "explore", "trending", "search", "profile"].includes(source)) {
        RecommendationAnalytics.create({
          userId: req.user._id,
          postId: post._id,
          source: source as any,
          action: "like",
          clickedAt: new Date(),
        }).catch(err => console.error("Analytics tracking error:", err));
      }

      // 🔔 Send notification to post owner (if not self-like)
      const postOwnerId = post.user.toString();
      if (postOwnerId !== userId) {
        await notifyLike(
          postOwnerId,
          userId,
          req.user.name || req.user.username || "User",
          post._id.toString(),
          post.title
        );
      }
    }

    await post.save();

    const populated = await ImagePost.findById(post._id)
      .populate("user", "username userType");

    if (!populated) {
      return res.status(404).json({ message: "Post not found after update" });
    }

    res.json({
      ...populated.toObject(),
      likes: populated.likedBy.length,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to toggle like" });
  }
};

/* =========================
   GET MY POSTS
========================= */
export const getMyImagePosts = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const posts = await ImagePost.find({ user: req.user._id })
      .populate("user", "username userType")
      .sort({ createdAt: -1 });

    const formatted = posts.map(post => ({
      ...post.toObject(),
      likes: post.likedBy?.length || 0,
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch my posts" });
  }
};

/* =========================
   GET USER'S POSTS
========================= */
export const getPostsByUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const posts = await ImagePost.find({ user: userId })
      .populate("user", "username userType")
      .sort({ createdAt: -1 });

    const formatted = posts.map(post => ({
      ...post.toObject(),
      likes: post.likedBy?.length || 0,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Fetch User Posts Error:", err);
    res.status(500).json({ message: "Failed to fetch user posts" });
  }
};

/* =========================
   SEARCH POSTS (Optimized with Text Index)
   How big apps do it:
   1. MongoDB text index with weighted fields (title > tags > description)
   2. $text query for stemming & relevance scoring
   3. Fallback to regex for partial/fuzzy matching
========================= */
export const searchPosts = async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string) || "";
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    if (!query.trim()) {
      return res.json([]);
    }

    let posts: any[] = [];
    
    // Try text search first (faster, uses index, supports stemming)
    try {
      posts = await ImagePost.find(
        { $text: { $search: query } },
        { score: { $meta: "textScore" } } // Include relevance score
      )
        .populate("user", "username userType profilePic")
        .sort({ score: { $meta: "textScore" }, views: -1 }) // Sort by relevance, then views
        .skip(skip)
        .limit(limit)
        .lean();
    } catch (textSearchError) {
      // Fallback to regex if text index not available or query fails
      posts = [];
    }

    // If text search returned no results, fallback to regex (for partial matches)
    if (posts.length === 0) {
      const searchRegex = new RegExp(query, "i");
      posts = await ImagePost.find({
        $or: [
          { title: { $regex: searchRegex } },
          { description: { $regex: searchRegex } },
          { tags: { $in: [searchRegex] } },
        ],
      })
        .populate("user", "username userType profilePic")
        .sort({ views: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    }

    const formatted = posts.map((post) => ({
      ...post,
      likes: (post as any).likedBy?.length || 0,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Search Posts Error:", err);
    res.status(500).json({ message: "Failed to search posts" });
  }
};

/* ======================================================
   GET TRENDING POSTS (The "Gravity" Algorithm)
   Logic: Score = (Views + Likes*5) / (HoursOld + 2)^1.5
   This ensures older viral posts eventually drop off.
====================================================== */
export const getTrendingPosts = async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

    const posts = await ImagePost.aggregate([
      {
        // 1. Only consider posts from last 7 days to speed up query
        $match: {
          createdAt: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      },
      {
        // 2. Calculate Score dynamically
        $addFields: {
          ageInHours: {
            $divide: [{ $subtract: [new Date(), "$createdAt"] }, 3600000],
          },
          popularity: {
            $add: [
              { $ifNull: ["$views", 0] },
              { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 5] }, // 1 Like = 5pts
            ],
          },
        },
      },
      {
        $addFields: {
          // Gravity Formula: Popularity / (Age + 2)^1.5
          trendScore: {
            $divide: [
              "$popularity",
              { $pow: [{ $add: ["$ageInHours", 2] }, 1.5] },
            ],
          },
        },
      },
      { $sort: { trendScore: -1 } }, // Highest score first
      { $limit: limit },
      {
        // 3. Populate User details
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 1,
          title: 1,
          description: 1,
          images: 1,
          tags: 1,
          views: 1,
          likedBy: 1,
          createdAt: 1,
          "user._id": 1,
          "user.username": 1,
          "user.userType": 1,
          "user.profilePic": 1,
        },
      },
    ]);

    const formattedPosts = posts.map((post) => ({
      ...post,
      likes: post.likedBy?.length || 0,
    }));

    // Also fetch trending tags (most used across all posts)
    const trendingTags = await ImagePost.aggregate([
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 },
      { $project: { tag: "$_id", count: 1, _id: 0 } },
    ]);

    res.json({
      posts: formattedPosts,
      tags: trendingTags,
    });
  } catch (err) {
    console.error("Get Trending Error:", err);
    res.status(500).json({ message: "Failed to fetch trending posts" });
  }
};

/* ======================================================
   GET RECOMMENDATIONS (Content-Based + Recency + Diversity)
   
   ALGORITHM: Lightweight Hybrid Recommendation
   
   Components:
   1. Content-Based (60%): Match user's top tags
   2. Engagement (15%): Popular posts with high likes/views  
   3. Recency Boost (15%): Recent high-engagement posts
   4. Diversity Injection (10%): Random quality posts to avoid filter bubble
   
   Ranking Formula:
   Score = (0.6 × tag_relevance) + (0.15 × engagement_rate) + 
           (0.15 × recency_boost) + (0.1 × diversity)
   
   Falls back to "Trending + Fresh" for cold start.
====================================================== */
export const getRecommendedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // ✅ SCALABILITY: Prevent expensive deep pagination
    const MAX_PAGE = 100; // Max 2000 posts deep
    if (page > MAX_PAGE) {
      return res.status(400).json({ 
        message: "Maximum page limit reached" 
      });
    }

    // A. Cold Start: If no user logged in, return Trending + Fresh mix
    if (!req.user) {
      const posts = await ImagePost.aggregate([
        {
          $addFields: {
            // Simple engagement score for anonymous users
            engagementScore: {
              $add: [
                { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 3] },
                { $multiply: ["$views", 1] },
              ],
            },
            // Recency boost (posts from last 7 days get bonus)
            recencyDays: {
              $divide: [
                { $subtract: [new Date(), "$createdAt"] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
        {
          $addFields: {
            recencyBoost: {
              $cond: {
                if: { $lte: ["$recencyDays", 7] },
                then: { $subtract: [7, "$recencyDays"] },
                else: 0,
              },
            },
          },
        },
        {
          $addFields: {
            finalScore: {
              $add: ["$engagementScore", { $multiply: ["$recencyBoost", 10] }],
            },
          },
        },
        { $sort: { finalScore: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            images: 1,
            tags: 1,
            views: 1,
            likedBy: 1,
            createdAt: 1,
            "user._id": 1,
            "user.username": 1,
            "user.userType": 1,
            "user.profilePic": 1,
          },
        },
      ]);

      const formatted = posts.map((post) => ({
        ...post,
        likes: post.likedBy?.length || 0,
      }));

      return res.json(formatted);
    }

    // B. Fetch User Interests & Liked Posts
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user._id);

    // Get top 8 tags (focused interest profile)
    const topTags =
      user?.interests
        ?.sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
        .slice(0, 8)
        .map((i: any) => (typeof i === "string" ? i : i.tag)) || [];

    // Get user's liked posts for collaborative filtering
    const userLikedPosts = await ImagePost.find({
      likedBy: req.user._id,
    }).select("_id").lean();
    
    const userLikedPostIds = userLikedPosts.map((p) => p._id);

    // C. If user has no interests yet, return 'Trending'
    if (topTags.length === 0 && userLikedPostIds.length === 0) {
      const posts = await ImagePost.aggregate([
        {
          $addFields: {
            engagementScore: {
              $add: [
                { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 3] },
                { $multiply: ["$views", 1] },
              ],
            },
          },
        },
        { $sort: { engagementScore: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            images: 1,
            tags: 1,
            views: 1,
            likedBy: 1,
            createdAt: 1,
            "user._id": 1,
            "user.username": 1,
            "user.userType": 1,
            "user.profilePic": 1,
          },
        },
      ]);

      const formatted = posts.map((post) => ({
        ...post,
        likes: post.likedBy?.length || 0,
      }));

      return res.json(formatted);
    }

    // D. LIGHTWEIGHT RECOMMENDATION ALGORITHM (No Collaborative Filtering)
    
    // D1. CONTENT-BASED - Posts matching user interests
    const contentBased = await ImagePost.aggregate([
      {
        $match: {
          tags: { $in: topTags },
          user: { $ne: req.user._id },
        },
      },
      {
        $addFields: {
          // Relevance: How many tags match
          relevance: {
            $size: {
              $setIntersection: [{ $ifNull: ["$tags", []] }, topTags],
            },
          },
          // Engagement rate (likes per view)
          engagementRate: {
            $cond: {
              if: { $gt: ["$views", 0] },
              then: {
                $divide: [
                  { $size: { $ifNull: ["$likedBy", []] } },
                  "$views",
                ],
              },
              else: 0,
            },
          },
          // Recency boost
          daysSincePost: {
            $divide: [
              { $subtract: [new Date(), "$createdAt"] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      {
        $addFields: {
          recencyBoost: {
            $cond: {
              if: { $lte: ["$daysSincePost", 7] },
              then: { $divide: [1, { $add: ["$daysSincePost", 1] }] },
              else: 0,
            },
          },
          // Content-based score: 60% relevance + 15% engagement + 15% recency
          hybridScore: {
            $add: [
              { $multiply: ["$relevance", 0.6] },          // 60% tag relevance
              { $multiply: ["$engagementRate", 100, 0.15] }, // 15% engagement
              { $multiply: ["$recencyBoost", 0.15] },      // 15% recency
            ],
          },
        },
      },
      { $sort: { hybridScore: -1 } },
      { $limit: Math.ceil(limit * 0.9) }, // 90% from content-based
    ]);

    // D2. Diversity Injection: Random quality posts (prevents filter bubble)
    const diversityPosts = await ImagePost.aggregate([
      {
        $match: {
          tags: { $not: { $in: topTags } }, // Different from user interests
          user: { $ne: req.user._id },
          views: { $gte: 50 }, // Quality threshold
        },
      },
      { $sample: { size: Math.ceil(limit * 0.1) } }, // 10% diversity
    ]);

    // D3. Combine sources
    const combined = [...contentBased, ...diversityPosts];
    
    // Sort by hybrid score (if exists) or random
    combined.sort((a, b) => {
      const scoreA = a.hybridScore || Math.random();
      const scoreB = b.hybridScore || Math.random();
      return scoreB - scoreA;
    });

    // D4. Pagination
    const paginated = combined.slice(skip, skip + limit);

    // D5. Populate user data
    const postIds = paginated.map((p) => p._id);
    const finalPosts = await ImagePost.find({ _id: { $in: postIds } })
      .populate("user", "username userType profilePic")
      .lean();

    // Maintain the score order
    const orderedPosts = paginated.map((p) => {
      const fullPost = finalPosts.find((fp: any) => fp._id.toString() === p._id.toString());
      return fullPost;
    }).filter(Boolean);

    const formattedPosts = orderedPosts.map((post: any) => ({
      ...post,
      type: 'post',
      likes: post.likedBy?.length || 0,
    }));

    // Add in-feed ad on every page for explore
    const now = new Date();
    const [ad] = await Ad.aggregate([
      { $match: { type: "in-feed", isActive: true, startDate: { $lte: now }, endDate: { $gte: now }, "payment.status": "paid" } },
      { $sample: { size: 1 } }
    ]);
    if (ad?.imageUrl) {
      await Ad.updateOne({ _id: ad._id }, { $inc: { impressions: 1 } });
      // Insert ad at position ~6 (earlier in the feed)
      const adPosition = Math.min(6, formattedPosts.length);
      formattedPosts.splice(adPosition, 0, { ...ad, type: 'ad' });
    }

    res.json(formattedPosts);
  } catch (err) {
    console.error("Get Recommendations Error:", err);
    res.status(500).json({ message: "Failed to fetch recommendations" });
  }
};

/* =========================
   EXPLORE (Extended Trending + Ads)
   - More trending posts for explore page
   - Includes ads every ~15 items
   - FALLBACK: "You might like" random posts when tag content runs out
========================= */
export const getExplore = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;
    const tag = req.query.tag as string; // Optional tag filter
    const now = new Date();

    const matchStage: any = {};
    if (tag) {
      matchStage.tags = { $regex: new RegExp(tag, "i") };
    }

    // Fetch posts and ads in parallel
    const [explorePosts, inFeedAds] = await Promise.all([
      ImagePost.aggregate([
        { $match: matchStage },
        {
          $addFields: {
            engagement: {
              $add: [
                { $ifNull: ["$views", 0] },
                { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 2] },
              ],
            },
          },
        },
        { $sort: { engagement: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            images: 1,
            tags: 1,
            views: 1,
            likedBy: 1,
            isBoosted: 1,
            createdAt: 1,
            "user._id": 1,
            "user.username": 1,
            "user.userType": 1,
            "user.profilePic": 1,
          },
        },
      ]),
      // Fetch 1 random in-feed ad for every page (more monetization)
      Ad.aggregate([
        { 
          $match: { 
            type: "in-feed",
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            "payment.status": "paid"
          } 
        }, 
        { $sample: { size: 1 } }
      ])
    ]);

    // Format posts with source marker
    let formattedPosts = explorePosts.map((post) => ({
      ...post,
      type: 'post',
      source: tag ? 'tag' : 'explore',
      likes: post.likedBy?.length || 0,
    }));

    // FALLBACK: If tag filtering returns less than expected, add "You might like" posts
    if (tag && formattedPosts.length < limit) {
      const existingIds = formattedPosts.map(p => p._id.toString());
      const fallbackNeeded = limit - formattedPosts.length;
      
      // Fetch random posts excluding current tag and already fetched posts
      const fallbackPosts = await ImagePost.aggregate([
        { 
          $match: { 
            _id: { $nin: existingIds.map(id => new mongoose.Types.ObjectId(id)) },
            tags: { $not: { $regex: new RegExp(tag, "i") } }
          } 
        },
        { $sample: { size: fallbackNeeded } },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            images: 1,
            tags: 1,
            views: 1,
            likedBy: 1,
            isBoosted: 1,
            createdAt: 1,
            "user._id": 1,
            "user.username": 1,
            "user.userType": 1,
            "user.profilePic": 1,
          },
        },
      ]);

      const formattedFallback = fallbackPosts.map((post) => ({
        ...post,
        type: 'post',
        source: 'youmightlike', // Marker for "You might like" section
        likes: post.likedBy?.length || 0,
      }));

      // Blend fallback posts naturally into the feed
      formattedPosts = [...formattedPosts, ...formattedFallback];
    }

    // Even for non-tag explore, ensure infinite scroll with random fallback
    if (!tag && formattedPosts.length < limit && page > 1) {
      const existingIds = formattedPosts.map(p => p._id.toString());
      const fallbackNeeded = limit - formattedPosts.length;
      
      const randomFallback = await ImagePost.aggregate([
        { $match: { _id: { $nin: existingIds.map(id => new mongoose.Types.ObjectId(id)) } } },
        { $sample: { size: fallbackNeeded } },
        {
          $lookup: {
            from: "users",
            localField: "user",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            images: 1,
            tags: 1,
            views: 1,
            likedBy: 1,
            isBoosted: 1,
            createdAt: 1,
            "user._id": 1,
            "user.username": 1,
            "user.userType": 1,
            "user.profilePic": 1,
          },
        },
      ]);

      const formattedRandom = randomFallback.map((post) => ({
        ...post,
        type: 'post',
        source: 'random',
        likes: post.likedBy?.length || 0,
      }));

      formattedPosts = [...formattedPosts, ...formattedRandom];
    }

    // Track ad impressions
    if (inFeedAds.length > 0) {
      await Ad.updateOne({ _id: inFeedAds[0]._id }, { $inc: { impressions: 1 } });
    }

    // Insert ad at position ~6 (earlier in the feed for visibility)
    if (inFeedAds.length > 0 && inFeedAds[0].imageUrl) {
      const adPosition = Math.min(6, formattedPosts.length);
      formattedPosts.splice(adPosition, 0, { ...inFeedAds[0], type: 'ad' });
    }

    res.json(formattedPosts);
  } catch (err) {
    console.error("Get Explore Error:", err);
    res.status(500).json({ message: "Failed to fetch explore" });
  }
};

/* ======================================================
   SMART FEED: Pinterest-Style Recommendation Algorithm
   
   Mixes multiple signals for an engaging, varied feed:
   - Personalized (based on user interests from DB)
   - Trending (high engagement posts)
   - Fresh (new posts from last 24-48h)
   - Boosted (seller promoted - blended in naturally)
   - Random Discovery (serendipity factor)
   - Ads (1 per ~12-15 items, not annoying)
   
   FALLBACK: When personalized/fresh runs out, uses random
   for truly infinite scrolling
====================================================== */
export const getHomeFeed = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 12;
    const skip = (page - 1) * limit;
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Get user interests and following list if logged in
    let userInterestTags: string[] = [];
    let followingIds: mongoose.Types.ObjectId[] = [];
    
    if (req.user) {
      const User = (await import("../models/User.js")).default;
      const user = await User.findById(req.user._id).select("interests following").lean();
      
      if (user?.interests && user.interests.length > 0) {
        // Get top 10 interests sorted by score
        userInterestTags = user.interests
          .sort((a: any, b: any) => (b.score || 0) - (a.score || 0))
          .slice(0, 10)
          .map((i: any) => i.tag);
      }
      
      // Get following list for "Following" stream
      if (user?.following && user.following.length > 0) {
        followingIds = user.following;
      }
    }

    // Parallel fetch different content streams
    const fetchPromises: Promise<any>[] = [
      // 1. FOLLOWING: Posts from users you follow (priority - 3 per page)
      followingIds.length > 0 ? ImagePost.aggregate([
        { $match: { user: { $in: followingIds }, isBoosted: { $ne: true } } },
        { $sort: { createdAt: -1 } }, // Newest first from followed users
        { $skip: skip },
        { $limit: 3 },
        { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        { $project: { _id: 1, title: 1, description: 1, images: 1, tags: 1, views: 1, likedBy: 1, createdAt: 1, "user._id": 1, "user.username": 1, "user.userType": 1, "user.profilePic": 1 } }
      ]) : Promise.resolve([]),

      // 2. PERSONALIZED: Posts matching user interests (3 per page if user has interests) - exclude boosted
      userInterestTags.length > 0 ? ImagePost.aggregate([
        { $match: { tags: { $in: userInterestTags }, isBoosted: { $ne: true } } },
        {
          $addFields: {
            relevanceScore: {
              $size: { $setIntersection: [{ $ifNull: ["$tags", []] }, userInterestTags] }
            },
            engagementScore: {
              $add: [
                { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 2] },
                { $ifNull: ["$views", 0] }
              ]
            }
          }
        },
        { $addFields: { combinedScore: { $add: [{ $multiply: ["$relevanceScore", 10] }, "$engagementScore"] } } },
        { $sort: { combinedScore: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: 3 },
        { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        { $project: { _id: 1, title: 1, description: 1, images: 1, tags: 1, views: 1, likedBy: 1, createdAt: 1, "user._id": 1, "user.username": 1, "user.userType": 1, "user.profilePic": 1 } }
      ]) : Promise.resolve([]),

      // 3. TRENDING: High engagement posts (3 per page) - exclude boosted
      ImagePost.aggregate([
        { $match: { isBoosted: { $ne: true } } },
        {
          $addFields: {
            engagementScore: {
              $add: [
                { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 3] },
                { $ifNull: ["$views", 0] },
                { $multiply: [{ $size: { $ifNull: ["$comments", []] } }, 2] }
              ]
            }
          }
        },
        { $sort: { engagementScore: -1 } },
        { $skip: skip },
        { $limit: 3 },
        { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        { $project: { _id: 1, title: 1, description: 1, images: 1, tags: 1, views: 1, likedBy: 1, createdAt: 1, "user._id": 1, "user.username": 1, "user.userType": 1, "user.profilePic": 1 } }
      ]),

      // 4. FRESH: New posts from last 48 hours (2 per page) - exclude boosted
      ImagePost.find({ createdAt: { $gte: twoDaysAgo }, isBoosted: { $ne: true } })
        .populate("user", "username userType profilePic")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(2)
        .lean(),

      // 5. BOOSTED: Seller promoted posts - 1 per page (industry standard like Instagram)
      ImagePost.find({ isBoosted: true, boostExpiresAt: { $gt: now } })
        .populate("user", "username userType profilePic")
        .sort({ boostedAt: -1 })
        .skip(page - 1) // Rotate through boosted posts across pages
        .limit(1)
        .lean(),

      // 6. RANDOM/FALLBACK: Ensures infinite scroll never ends - exclude boosted
      // Uses $sample for true randomness (reshuffles automatically)
      ImagePost.aggregate([
        { $match: { isBoosted: { $ne: true } } },
        { $sample: { size: 8 } }, // More random posts for variety
        { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        { $project: { _id: 1, title: 1, description: 1, images: 1, tags: 1, views: 1, likedBy: 1, createdAt: 1, "user._id": 1, "user.username": 1, "user.userType": 1, "user.profilePic": 1 } }
      ]),

      // 7. IN-FEED AD: 1 per page (standard frequency like Instagram/Facebook)
      Ad.aggregate([
        { $match: { type: "in-feed", isActive: true, startDate: { $lte: now }, endDate: { $gte: now }, "payment.status": "paid" } },
        { $sample: { size: 1 } }
      ]),

      // 8. BANNER AD: Only on page 1
      page === 1 ? Ad.aggregate([
        { $match: { type: "banner", isActive: true, startDate: { $lte: now }, endDate: { $gte: now }, "payment.status": "paid" } },
        { $sample: { size: 1 } }
      ]) : Promise.resolve([])
    ];

    const [followingPosts, personalizedPosts, trendingPosts, freshPosts, boostedPosts, randomPosts, ads, bannerAd] = await Promise.all(fetchPromises);

    // Track boost views
    const boostedIds = boostedPosts.map((p: any) => p._id);
    if (boostedIds.length > 0) {
      await ImagePost.updateMany({ _id: { $in: boostedIds } }, { $inc: { boostViews: 1 } });
    }

    // Track ad impressions
    if (ads.length > 0) {
      await Ad.updateOne({ _id: ads[0]._id }, { $inc: { impressions: 1 } });
    }
    if (bannerAd.length > 0) {
      await Ad.updateOne({ _id: bannerAd[0]._id }, { $inc: { impressions: 1 } });
    }

    // SMART SHUFFLE: Interleave different content types for variety
    const allPosts: any[] = [];
    const seenIds = new Set<string>();

    const addUnique = (posts: any[], source: string) => {
      for (const post of posts) {
        if (!post?._id) continue;
        const id = post._id.toString();
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allPosts.push({ ...post, _source: source });
        }
      }
    };

    // Interleave: Following first (priority!), then personalized, trending, fresh, random
    // Boosted posts will be inserted naturally later
    const maxLen = Math.max(
      followingPosts.length,
      personalizedPosts.length,
      trendingPosts.length,
      freshPosts.length,
      randomPosts.length
    );

    for (let i = 0; i < maxLen; i++) {
      // Following posts get priority - show first
      if (followingPosts[i]) addUnique([followingPosts[i]], 'following');
      if (personalizedPosts[i]) addUnique([personalizedPosts[i]], 'personalized');
      if (trendingPosts[i]) addUnique([trendingPosts[i]], 'trending');
      if (freshPosts[i]) addUnique([freshPosts[i]], 'fresh');
      if (randomPosts[i]) addUnique([randomPosts[i]], 'random');
    }

    // FALLBACK: If we don't have enough posts, add more random ones
    // This ensures infinite scroll NEVER ends
    if (allPosts.length < limit) {
      const additionalRandom = await ImagePost.aggregate([
        { $match: { _id: { $nin: Array.from(seenIds).map(id => new mongoose.Types.ObjectId(id)) }, isBoosted: { $ne: true } } },
        { $sample: { size: limit - allPosts.length + 3 } },
        { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "user" } },
        { $unwind: "$user" },
        { $project: { _id: 1, title: 1, description: 1, images: 1, tags: 1, views: 1, likedBy: 1, createdAt: 1, "user._id": 1, "user.username": 1, "user.userType": 1, "user.profilePic": 1 } }
      ]);
      addUnique(additionalRandom, 'fallback');
    }

    // Limit to page size
    let feedPosts = allPosts.slice(0, limit);

    // SHUFFLE first few posts on page 1 to prevent same post always at position 1
    // Keep positions 0-4 shuffled for variety while maintaining relevance
    if (page === 1 && feedPosts.length > 3) {
      const shuffleCount = Math.min(5, feedPosts.length);
      const toShuffle = feedPosts.slice(0, shuffleCount);
      const rest = feedPosts.slice(shuffleCount);
      // Fisher-Yates shuffle
      for (let i = toShuffle.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [toShuffle[i], toShuffle[j]] = [toShuffle[j], toShuffle[i]];
      }
      feedPosts = [...toShuffle, ...rest];
    }

    // Format feed with likes count
    const feed: any[] = feedPosts.map(post => ({
      ...post,
      type: 'post',
      likes: post.likedBy?.length || 0
    }));

    // INSERT BOOSTED POSTS NATURALLY (like Instagram sponsored posts)
    // - Only 1 boosted post per eligible page (less spammy)
    // - Appear at truly random positions (changes on every refresh)
    if (boostedPosts.length > 0) {
      const boosted = boostedPosts[0]; // Only take first one
      if (boosted?._id && !seenIds.has(boosted._id.toString())) {
        // TRUE RANDOM position between 4-10 (not too early, not too late)
        const minPos = 4;
        const maxPos = Math.min(10, feed.length);
        const insertPosition = Math.floor(Math.random() * (maxPos - minPos + 1)) + minPos;
        
        feed.splice(insertPosition, 0, {
          ...boosted,
          type: 'post',
          isBoosted: true,
          _source: 'boosted',
          likes: boosted.likedBy?.length || 0
        });
        
        seenIds.add(boosted._id.toString());
      }
    }

    // Insert ad at RANDOM position (5-9) - every page, varied position
    if (ads.length > 0 && ads[0].imageUrl) {
      const minAdPos = 5;
      const maxAdPos = Math.min(9, feed.length);
      const adPosition = Math.floor(Math.random() * (maxAdPos - minAdPos + 1)) + minAdPos;
      feed.splice(adPosition, 0, { ...ads[0], type: 'ad' });
    }

    // Remove internal fields
    const finalFeed = feed.map(({ _source, ...rest }) => rest);

    // TRULY INFINITE: Always return hasMore=true
    // The $sample query ensures we get random posts even when user has scrolled through all
    // This mimics TikTok/Instagram where you never hit "end of feed"
    res.json({
      feed: finalFeed,
      banner: bannerAd[0] || null,
      page,
      hasMore: true // ALWAYS true - infinite scroll forever
    });

  } catch (err) {
    console.error("Feed Error:", err);
    res.status(500).json({ message: "Failed to load feed" });
  }
};

/* ======================================================
   BOOST POST (Seller Action)
   - Business accounts can boost up to 4 posts
   - Boost lasts for 1 week
====================================================== */
export const boostPost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    // Only business accounts can boost
    if (req.user.userType !== "business") {
      return res.status(403).json({ message: "Only business accounts can boost posts" });
    }

    const { postId } = req.params;

    // Check if user owns the post
    const post = await ImagePost.findOne({ _id: postId, user: req.user._id });
    if (!post) {
      return res.status(404).json({ message: "Post not found or you don't own it" });
    }

    // Check active boost count (max 4)
    const now = new Date();
    const activeBoostedCount = await ImagePost.countDocuments({
      user: req.user._id,
      isBoosted: true,
      boostExpiresAt: { $gt: now }
    });

    if (activeBoostedCount >= 4) {
      return res.status(400).json({ 
        message: "Maximum boost limit reached (4 posts). Wait for existing boosts to expire." 
      });
    }

    // Already boosted?
    if (post.isBoosted && post.boostExpiresAt && post.boostExpiresAt > now) {
      return res.status(400).json({ 
        message: "This post is already boosted",
        expiresAt: post.boostExpiresAt
      });
    }

    // Apply boost (1 week duration)
    const oneWeekLater = new Date();
    oneWeekLater.setDate(oneWeekLater.getDate() + 7);

    post.isBoosted = true;
    post.boostedAt = now;
    post.boostExpiresAt = oneWeekLater;
    post.boostViews = 0; // Reset boost views for fresh tracking
    await post.save();

    res.json({
      message: "Post boosted successfully! 🚀",
      post: {
        _id: post._id,
        title: post.title,
        isBoosted: post.isBoosted,
        boostedAt: post.boostedAt,
        boostExpiresAt: post.boostExpiresAt
      }
    });

  } catch (err) {
    console.error("Boost Error:", err);
    res.status(500).json({ message: "Failed to boost post" });
  }
};

/* ======================================================
   UNBOOST POST (Seller Action)
   - Cancel boost early
====================================================== */
export const unboostPost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { postId } = req.params;

    const post = await ImagePost.findOne({ _id: postId, user: req.user._id });
    if (!post) {
      return res.status(404).json({ message: "Post not found or you don't own it" });
    }

    post.isBoosted = false;
    post.boostExpiresAt = undefined;
    await post.save();

    res.json({ message: "Boost removed", postId });

  } catch (err) {
    console.error("Unboost Error:", err);
    res.status(500).json({ message: "Failed to unboost post" });
  }
};

/* ======================================================
   GET MY BOOST STATUS (Seller Dashboard)
   - Shows current boost status for seller's posts
====================================================== */
export const getMyBoostStatus = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const now = new Date();

    // Get all user's posts with boost info
    const posts = await ImagePost.find({ user: req.user._id })
      .select("_id title images isBoosted boostedAt boostExpiresAt boostViews views")
      .sort({ boostedAt: -1 })
      .lean();

    const boostedPosts = posts.filter(
      p => p.isBoosted && p.boostExpiresAt && new Date(p.boostExpiresAt) > now
    );

    const availableSlots = 4 - boostedPosts.length;

    res.json({
      boostedPosts,
      availableSlots,
      maxSlots: 4,
      allPosts: posts.map(p => ({
        ...p,
        canBoost: !p.isBoosted || !p.boostExpiresAt || new Date(p.boostExpiresAt) <= now
      }))
    });

  } catch (err) {
    console.error("Boost Status Error:", err);
    res.status(500).json({ message: "Failed to fetch boost status" });
  }
};

/* ======================================================
   GET ALL BOOSTED POSTS (Admin Dashboard)
   - View all currently boosted posts across platform
====================================================== */
export const getAllBoostedPosts = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const includeExpired = req.query.includeExpired === "true";

    const query: any = { isBoosted: true };
    if (!includeExpired) {
      query.boostExpiresAt = { $gt: now };
    }

    const boostedPosts = await ImagePost.find(query)
      .populate("user", "username email companyName userType profilePic")
      .select("title images views boostViews isBoosted boostedAt boostExpiresAt createdAt")
      .sort({ boostedAt: -1 })
      .lean();

    // Add computed fields
    const enriched = boostedPosts.map(post => ({
      ...post,
      isActive: post.boostExpiresAt ? new Date(post.boostExpiresAt) > now : false,
      daysRemaining: post.boostExpiresAt 
        ? Math.max(0, Math.ceil((new Date(post.boostExpiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
        : 0
    }));

    res.json({
      total: enriched.length,
      active: enriched.filter(p => p.isActive).length,
      posts: enriched
    });

  } catch (err) {
    console.error("Get All Boosted Error:", err);
    res.status(500).json({ message: "Failed to fetch boosted posts" });
  }
};

/* =========================
   GET SIMILAR POSTS (Tag-Based Recommendations)
   Returns posts with similar tags for "More Like This"
========================= */
export const getSimilarPosts = async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    const limit = parseInt(req.query.limit as string) || 6;

    // Get the current post's tags
    const currentPost = await ImagePost.findById(postId).select('tags user').lean();
    if (!currentPost) {
      return res.status(404).json({ message: "Post not found" });
    }

    const tags = currentPost.tags || [];
    
    if (tags.length === 0) {
      // No tags - return recent posts as fallback
      const fallbackPosts = await ImagePost.find({ _id: { $ne: postId } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('user', 'username profilePic userType')
        .select('images title tags views likedBy createdAt')
        .lean();
      
      return res.json(fallbackPosts.map(p => ({
        ...p,
        likes: p.likedBy?.length || 0,
      })));
    }

    // Find posts with matching tags, scored by overlap count
    const similarPosts = await ImagePost.aggregate([
      {
        $match: {
          _id: { $ne: new mongoose.Types.ObjectId(postId) },
          tags: { $in: tags },
        },
      },
      {
        $addFields: {
          // Count how many tags match
          tagMatchCount: {
            $size: { $setIntersection: ["$tags", tags] },
          },
          // Engagement score
          engagementScore: {
            $add: [
              { $multiply: [{ $size: { $ifNull: ["$likedBy", []] } }, 2] },
              { $ifNull: ["$views", 0] },
            ],
          },
        },
      },
      {
        $addFields: {
          // Combined score: tag similarity (70%) + engagement (30%)
          similarityScore: {
            $add: [
              { $multiply: ["$tagMatchCount", 10] },
              { $multiply: ["$engagementScore", 0.3] },
            ],
          },
        },
      },
      { $sort: { similarityScore: -1, createdAt: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 1,
          title: 1,
          images: 1,
          tags: 1,
          views: 1,
          likedBy: 1,
          createdAt: 1,
          tagMatchCount: 1,
          "user._id": 1,
          "user.username": 1,
          "user.profilePic": 1,
          "user.userType": 1,
        },
      },
    ]);

    const formatted = similarPosts.map((post) => ({
      ...post,
      likes: post.likedBy?.length || 0,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Get Similar Posts Error:", err);
    res.status(500).json({ message: "Failed to fetch similar posts" });
  }
};

/* =========================
   REPORT POST
========================= */
export const reportPost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { postId } = req.params;
    const { reason, customReason } = req.body;

    const validReasons = ["stolen_content", "inappropriate", "spam", "misleading", "harassment", "other"];
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({ message: "Invalid report reason" });
    }

    // Check if post exists
    const post = await ImagePost.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Check if already reported by this user
    const existingReport = await Report.findOne({ post: postId, reporter: req.user._id });
    if (existingReport) {
      return res.status(400).json({ message: "You have already reported this post" });
    }

    const report = await Report.create({
      post: postId,
      reporter: req.user._id,
      reason,
      customReason: reason === "other" ? customReason : undefined,
    });

    res.status(201).json({ success: true, message: "Post reported successfully", report });
  } catch (err) {
    console.error("Report Post Error:", err);
    res.status(500).json({ message: "Failed to report post" });
  }
};

/* =========================
   DON'T RECOMMEND POST
========================= */
export const dontRecommendPost = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { postId } = req.params;

    // Add negative weight to user's interests for this post's tags
    const post = await ImagePost.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Add negative weight to decrease recommendation of similar content
    if (post.tags && post.tags.length > 0) {
      interestBuffer.add(req.user._id.toString(), post.tags, -10); // Negative weight
    }

    res.json({ success: true, message: "Preference updated" });
  } catch (err) {
    console.error("Don't Recommend Error:", err);
    res.status(500).json({ message: "Failed to update preference" });
  }
};