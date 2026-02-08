// src/services/typesenseSync.ts
/**
 * Typesense Sync Service
 * 
 * Handles syncing MongoDB documents to Typesense:
 * - Real-time sync on create/update/delete
 * - Batch sync for initial data population
 * - Incremental sync for catching up
 */

import {
  getTypesenseClient,
  isTypesenseAvailable,
  initializeTypesenseCollections,
  postsCollectionSchema,
  usersCollectionSchema,
  tagsCollectionSchema,
  recreateCollection,
} from "../config/typesense.js";
import ImagePost from "../models/ImagePost.js";
import User from "../models/User.js";

// ==========================================
// DOCUMENT TRANSFORMERS
// ==========================================

/**
 * Transform MongoDB post to Typesense document
 */
export const transformPostForTypesense = (post: any, user?: any) => {
  const postUser = user || post.user;
  
  return {
    id: post._id.toString(),
    title: post.title || "",
    description: post.description || "",
    tags: post.tags || [],
    price: post.price || 0,
    views: post.views || 0,
    likes: post.likedBy?.length || 0,
    userId: postUser?._id?.toString() || post.user?.toString() || "",
    username: postUser?.username || "",
    userType: postUser?.userType || "general",
    profilePic: postUser?.profilePic || "",
    companyName: postUser?.companyName || "",
    isVerified: postUser?.isVerified || false,
    imageUrl: post.images?.[0]?.low || "",
    imageUrlHigh: post.images?.[0]?.high || "",
    isBoosted: post.isBoosted || false,
    isArchived: post.isArchived || false,
    createdAt: post.createdAt ? new Date(post.createdAt).getTime() : Date.now(),
  };
};

/**
 * Transform MongoDB user to Typesense document
 */
export const transformUserForTypesense = (user: any) => {
  return {
    id: user._id.toString(),
    username: user.username || "",
    name: user.name || "",
    email: user.email || "",
    userType: user.userType || "general",
    companyName: user.companyName || "",
    bio: user.bio || "",
    profilePic: user.profilePic || "",
    location: user.location || "",
    isVerified: user.isVerified || false,
    followersCount: user.followers?.length || 0,
    followingCount: user.following?.length || 0,
    productType: user.productType || "",
    createdAt: user.createdAt ? new Date(user.createdAt).getTime() : Date.now(),
  };
};

// ==========================================
// REAL-TIME SYNC OPERATIONS
// ==========================================

/**
 * Index or update a single post
 */
export const indexPost = async (post: any, user?: any): Promise<boolean> => {
  if (!(await isTypesenseAvailable())) return false;
  
  try {
    const client = getTypesenseClient();
    const document = transformPostForTypesense(post, user);
    
    await client.collections("posts").documents().upsert(document);
    console.log(`📝 Indexed post ${post._id} to Typesense`);
    return true;
  } catch (error) {
    console.error("❌ Failed to index post:", (error as Error).message);
    return false;
  }
};

/**
 * Delete a post from index
 */
export const deletePostFromIndex = async (postId: string): Promise<boolean> => {
  if (!(await isTypesenseAvailable())) return false;
  
  try {
    const client = getTypesenseClient();
    await client.collections("posts").documents(postId).delete();
    console.log(`🗑️ Deleted post ${postId} from Typesense`);
    return true;
  } catch (error: any) {
    if (error.httpStatus === 404) return true; // Already deleted
    console.error("❌ Failed to delete post:", error.message);
    return false;
  }
};

/**
 * Index or update a single user
 */
export const indexUser = async (user: any): Promise<boolean> => {
  if (!(await isTypesenseAvailable())) return false;
  
  // Don't index admin users
  if (user.userType === "admin") return true;
  
  try {
    const client = getTypesenseClient();
    const document = transformUserForTypesense(user);
    
    await client.collections("users").documents().upsert(document);
    console.log(`📝 Indexed user ${user._id} to Typesense`);
    return true;
  } catch (error) {
    console.error("❌ Failed to index user:", (error as Error).message);
    return false;
  }
};

/**
 * Delete a user from index
 */
export const deleteUserFromIndex = async (userId: string): Promise<boolean> => {
  if (!(await isTypesenseAvailable())) return false;
  
  try {
    const client = getTypesenseClient();
    await client.collections("users").documents(userId).delete();
    console.log(`🗑️ Deleted user ${userId} from Typesense`);
    return true;
  } catch (error: any) {
    if (error.httpStatus === 404) return true;
    console.error("❌ Failed to delete user:", error.message);
    return false;
  }
};

// ==========================================
// BATCH SYNC OPERATIONS
// ==========================================

/**
 * Sync all posts to Typesense (batch import)
 */
export const syncAllPosts = async (options?: {
  batchSize?: number;
  onProgress?: (synced: number, total: number) => void;
}): Promise<{ success: number; failed: number; total: number }> => {
  const batchSize = options?.batchSize || 100;
  const client = getTypesenseClient();
  
  let success = 0;
  let failed = 0;
  
  // Get total count
  const total = await ImagePost.countDocuments({ isArchived: { $ne: true } });
  console.log(`📊 Syncing ${total} posts to Typesense...`);
  
  // Process in batches
  let skip = 0;
  while (skip < total) {
    const posts = await ImagePost.find({ isArchived: { $ne: true } })
      .populate("user", "username userType profilePic companyName isVerified")
      .skip(skip)
      .limit(batchSize)
      .lean();
    
    if (posts.length === 0) break;
    
    const documents = posts.map((post) => transformPostForTypesense(post));
    
    try {
      const results = await client
        .collections("posts")
        .documents()
        .import(documents, { action: "upsert" });
      
      // Count successes and failures
      results.forEach((result: any) => {
        if (result.success) success++;
        else {
          failed++;
          console.error("Import error:", result.error);
        }
      });
    } catch (error) {
      console.error("Batch import error:", error);
      failed += posts.length;
    }
    
    skip += batchSize;
    options?.onProgress?.(skip, total);
    console.log(`📝 Synced ${Math.min(skip, total)}/${total} posts`);
  }
  
  console.log(`✅ Posts sync complete: ${success} success, ${failed} failed`);
  return { success, failed, total };
};

/**
 * Sync all users to Typesense (batch import)
 */
export const syncAllUsers = async (options?: {
  batchSize?: number;
  onProgress?: (synced: number, total: number) => void;
}): Promise<{ success: number; failed: number; total: number }> => {
  const batchSize = options?.batchSize || 100;
  const client = getTypesenseClient();
  
  let success = 0;
  let failed = 0;
  
  // Get total count (exclude admins)
  const total = await User.countDocuments({ userType: { $ne: "admin" } });
  console.log(`📊 Syncing ${total} users to Typesense...`);
  
  // Process in batches
  let skip = 0;
  while (skip < total) {
    const users = await User.find({ userType: { $ne: "admin" } })
      .skip(skip)
      .limit(batchSize)
      .lean();
    
    if (users.length === 0) break;
    
    const documents = users.map((user) => transformUserForTypesense(user));
    
    try {
      const results = await client
        .collections("users")
        .documents()
        .import(documents, { action: "upsert" });
      
      results.forEach((result: any) => {
        if (result.success) success++;
        else {
          failed++;
          console.error("Import error:", result.error);
        }
      });
    } catch (error) {
      console.error("Batch import error:", error);
      failed += users.length;
    }
    
    skip += batchSize;
    options?.onProgress?.(skip, total);
    console.log(`📝 Synced ${Math.min(skip, total)}/${total} users`);
  }
  
  console.log(`✅ Users sync complete: ${success} success, ${failed} failed`);
  return { success, failed, total };
};

/**
 * Sync all tags (aggregate from posts)
 */
export const syncAllTags = async (): Promise<{ success: number; total: number }> => {
  const client = getTypesenseClient();
  
  // Aggregate tags from posts
  const tagAggregation = await ImagePost.aggregate([
    { $match: { isArchived: { $ne: true } } },
    { $unwind: "$tags" },
    { $group: { _id: "$tags", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5000 }, // Top 5000 tags
  ]);
  
  const documents = tagAggregation.map((t, index) => ({
    id: `tag_${index}_${t._id.replace(/[^a-zA-Z0-9]/g, "_")}`,
    tag: t._id,
    count: t.count,
  }));
  
  console.log(`📊 Syncing ${documents.length} tags to Typesense...`);
  
  try {
    // Clear existing tags and re-import
    await recreateCollection("tags", tagsCollectionSchema);
    
    const results = await client
      .collections("tags")
      .documents()
      .import(documents, { action: "create" });
    
    const success = results.filter((r: any) => r.success).length;
    console.log(`✅ Tags sync complete: ${success}/${documents.length}`);
    return { success, total: documents.length };
  } catch (error) {
    console.error("Tags sync error:", error);
    return { success: 0, total: documents.length };
  }
};

/**
 * Full sync - reinitialize all collections and sync all data
 */
export const fullSync = async (): Promise<{
  posts: { success: number; failed: number; total: number };
  users: { success: number; failed: number; total: number };
  tags: { success: number; total: number };
}> => {
  console.log("🚀 Starting full Typesense sync...");
  
  // Reinitialize collections (handles schema changes)
  await recreateCollection("posts", postsCollectionSchema);
  await recreateCollection("users", usersCollectionSchema);
  
  // Sync all data
  const [posts, users, tags] = await Promise.all([
    syncAllPosts(),
    syncAllUsers(),
    syncAllTags(),
  ]);
  
  console.log("✅ Full sync complete!");
  return { posts, users, tags };
};

// ==========================================
// INITIALIZATION
// ==========================================

/**
 * Initialize Typesense on server startup
 */
export const initializeTypesense = async (): Promise<boolean> => {
  const available = await isTypesenseAvailable();
  
  if (!available) {
    console.log("ℹ️ Typesense not available - using MongoDB for search");
    return false;
  }
  
  try {
    await initializeTypesenseCollections();
    console.log("✅ Typesense initialized successfully");
    return true;
  } catch (error) {
    console.error("❌ Failed to initialize Typesense:", error);
    return false;
  }
};

export default {
  // Real-time sync
  indexPost,
  deletePostFromIndex,
  indexUser,
  deleteUserFromIndex,
  
  // Batch sync
  syncAllPosts,
  syncAllUsers,
  syncAllTags,
  fullSync,
  
  // Init
  initializeTypesense,
  
  // Transformers (for testing)
  transformPostForTypesense,
  transformUserForTypesense,
};
