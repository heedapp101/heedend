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

export default router;
