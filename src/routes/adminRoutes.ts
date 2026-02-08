import express from "express";
import { 
  getPendingApprovals, 
  approveUser, 
  rejectUser,
  getDashboardStats,
  getAllUsers,
  getRecommendationAnalytics,
  updateDwellTime,
  getReportedPosts,
  updateReportStatus,
  deleteReportedPost,
  // Typesense sync endpoints
  getTypesenseStatus,
  typesenseFullSync,
  typesenseSyncPosts,
  typesenseSyncUsers,
  typesenseSyncTags,
} from "../controllers/adminController.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";

const router = express.Router();

// ✅ SECURITY: All admin routes require both auth and admin role
router.get("/stats", requireAuth, adminMiddleware, getDashboardStats);
router.get("/analytics/recommendations", requireAuth, adminMiddleware, getRecommendationAnalytics);
router.post("/analytics/dwell-time", requireAuth, updateDwellTime); // Available to all authenticated users
router.get("/users", requireAuth, adminMiddleware, getAllUsers);
router.get("/approvals", requireAuth, adminMiddleware, getPendingApprovals);
router.put("/approve/:id", requireAuth, adminMiddleware, approveUser);
router.delete("/reject/:id", requireAuth, adminMiddleware, rejectUser);

// ✅ REPORTS: Manage reported posts
router.get("/reports", requireAuth, adminMiddleware, getReportedPosts);
router.put("/reports/:reportId", requireAuth, adminMiddleware, updateReportStatus);
router.delete("/reports/post/:postId", requireAuth, adminMiddleware, deleteReportedPost);

// ✅ TYPESENSE: Search index management
router.get("/typesense/status", requireAuth, adminMiddleware, getTypesenseStatus);
router.post("/typesense/sync", requireAuth, adminMiddleware, typesenseFullSync);
router.post("/typesense/sync/posts", requireAuth, adminMiddleware, typesenseSyncPosts);
router.post("/typesense/sync/users", requireAuth, adminMiddleware, typesenseSyncUsers);
router.post("/typesense/sync/tags", requireAuth, adminMiddleware, typesenseSyncTags);

export default router;