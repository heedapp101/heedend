import { Router } from "express";
import {
  createAd,
  getAllAds,
  getAdById,
  updateAd,
  deleteAd,
  toggleAdStatus,
  updatePaymentStatus,
  trackAdClick,
  getAdAnalytics,
  getActiveAds
} from "../controllers/adController.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/upload.js";

const router = Router();

/* ============================================
   AD ROUTES
   - Admin: Full CRUD + Analytics
   - Public: Get active ads, track clicks
============================================ */

// === PUBLIC ROUTES ===
// Get active ads for display (frontend)
router.get("/active", getActiveAds);

// Track ad click (redirect handler)
router.post("/:id/click", trackAdClick);

// === ADMIN ROUTES (Protected) ===
// Get all ads with stats
router.get("/", requireAuth, getAllAds);

// Get ad analytics
router.get("/analytics", requireAuth, getAdAnalytics);

// Get single ad
router.get("/:id", requireAuth, getAdById);

// Create new ad (with image upload)
router.post("/", requireAuth, upload.single("image"), createAd);

// Update ad (with optional image upload)
router.put("/:id", requireAuth, upload.single("image"), updateAd);

// Delete ad
router.delete("/:id", requireAuth, deleteAd);

// Toggle ad active status
router.patch("/:id/toggle", requireAuth, toggleAdStatus);

// Update payment status
router.patch("/:id/payment", requireAuth, updatePaymentStatus);

export default router;
