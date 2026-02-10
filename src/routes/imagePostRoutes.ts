import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  createImagePost,
  getAllImagePosts,   
  getMyImagePosts,   
  getPostsByUser,
  getSinglePost,     
  toggleLikePost,
  searchPosts,
  getTrendingPosts,
  getRecommendedPosts,
  getExplore,
  getHomeFeed,
  boostPost,
  unboostPost,
  getMyBoostStatus,
  getAllBoostedPosts,
  reportPost,
  dontRecommendPost,
  getSimilarPosts,
  updatePost,
  deletePost,
  archivePost,
  getMyArchivedPosts,
} from "../controllers/imagePostController.js";
import { requireAuth, optionalAuth } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/upload.js";
import { getSellerStats } from "../controllers/imagePostController.js";

const router = Router();

// ✅ SCALABILITY: Rate limiting for expensive operations
const recommendationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Max 30 requests per minute per IP
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60, // More lenient for search
  message: { message: 'Too many search requests, please slow down.' },
});

/* ---------- SEARCH & DISCOVERY ---------- */
router.get("/search", searchLimiter, searchPosts);
router.get("/trending", getTrendingPosts); // No rate limit (cached)
router.get("/recommended", recommendationLimiter, optionalAuth, getRecommendedPosts);
router.get("/explore", getExplore);

/* ---------- SMART FEED (Home Screen) ---------- */
router.get("/feed", optionalAuth, getHomeFeed);

/* ---------- BOOST MANAGEMENT ---------- */
router.get("/boost/status", requireAuth, getMyBoostStatus);    // Seller: Get my boost status
router.get("/boost/all", requireAuth, getAllBoostedPosts);     // Admin: Get all boosted posts
router.post("/boost/:postId", requireAuth, boostPost);         // Seller: Boost a post
router.delete("/boost/:postId", requireAuth, unboostPost);     // Seller: Unboost a post

/* ---------- CREATE POST ---------- */
router.post(
  "/create",
  requireAuth,
  upload.array("images", 4),
  createImagePost
);

/* ---------- GET ALL POSTS (HomeScreen) ---------- */
router.get("/", getAllImagePosts);

/* ---------- GET MY POSTS ---------- */
router.get("/posts/me", requireAuth, getMyImagePosts);

/* ---------- GET MY ARCHIVED POSTS ---------- */
router.get("/posts/archived", requireAuth, getMyArchivedPosts);

/* ---------- GET ANY USER'S POSTS (ProfileScreen) ---------- */
router.get("/user/:userId", getPostsByUser);

/* ---------- SELLER STATS ---------- */
router.get("/seller/stats", requireAuth, getSellerStats);

/* ---------- GET SIMILAR POSTS (More Like This) ---------- */
router.get("/:postId/similar", getSimilarPosts);

/* ---------- GET SINGLE POST (ItemScreen) ---------- */
router.get("/:id", optionalAuth, getSinglePost);

/* ---------- TOGGLE LIKE ---------- */
router.post("/:postId/like", requireAuth, toggleLikePost);

/* ---------- REPORT & PREFERENCE ---------- */
router.post("/:postId/report", requireAuth, reportPost);
router.post("/:postId/dont-recommend", requireAuth, dontRecommendPost);

/* ---------- DELETE & ARCHIVE POST ---------- */
router.put("/:postId", requireAuth, updatePost);
router.delete("/:postId", requireAuth, deletePost);
router.post("/:postId/archive", requireAuth, archivePost);

export default router;
