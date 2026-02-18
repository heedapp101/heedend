import express from "express";
import { 
  getPendingApprovals, 
  approveUser, 
  rejectUser,
  getDashboardStats,
  getAllUsers,
  getDeletedUsers,
  getRecommendationAnalytics,
  updateDwellTime,
  getAwardCandidates,
  updateAwardStatus,
  updatePostVisibility,
  getReportedPosts,
  updateReportStatus,
  deleteReportedPost,
  getReportedUsers,
  updateUserReportStatus,
  banReportedUser,
  updateAdminProfile,
  getAdminProfile,
  // New award functions
  awardPost,
  awardUser,
  getAllAwards,
  updateAward,
  deleteAward,
  getAwardedContent,
} from "../controllers/adminController.js";
import { upload } from "../middleware/upload.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";

const router = express.Router();

// ✅ SECURITY: All admin routes require both auth and admin role
router.get("/stats", requireAuth, adminMiddleware, getDashboardStats);
router.get("/analytics/recommendations", requireAuth, adminMiddleware, getRecommendationAnalytics);
router.post("/analytics/dwell-time", requireAuth, updateDwellTime); // Available to all authenticated users
router.get("/users", requireAuth, adminMiddleware, getAllUsers);
router.get("/users/deleted", requireAuth, adminMiddleware, getDeletedUsers);
router.get("/approvals", requireAuth, adminMiddleware, getPendingApprovals);
router.put("/approve/:id", requireAuth, adminMiddleware, approveUser);
router.delete("/reject/:id", requireAuth, adminMiddleware, rejectUser);

// ✅ AWARDS / PROMOTION (Legacy)
router.get("/awards/candidates", requireAuth, adminMiddleware, getAwardCandidates);
router.patch("/awards/:postId", requireAuth, adminMiddleware, updateAwardStatus);
router.patch("/posts/:postId/visibility", requireAuth, adminMiddleware, updatePostVisibility);

// ✅ ENHANCED AWARDS SYSTEM
router.get("/awards/all", requireAuth, adminMiddleware, getAllAwards);
router.post("/awards/post/:postId", requireAuth, adminMiddleware, awardPost);
router.post("/awards/user/:userId", requireAuth, adminMiddleware, awardUser);
router.put("/awards/manage/:awardId", requireAuth, adminMiddleware, updateAward);
router.delete("/awards/manage/:awardId", requireAuth, adminMiddleware, deleteAward);
router.get("/awards/public", getAwardedContent); // Public endpoint - no auth required

// ✅ REPORTS: Manage reported posts
router.get("/reports", requireAuth, adminMiddleware, getReportedPosts);
router.put("/reports/:reportId", requireAuth, adminMiddleware, updateReportStatus);
router.delete("/reports/post/:postId", requireAuth, adminMiddleware, deleteReportedPost);

// ✅ USER REPORTS: Manage reported users
router.get("/user-reports", requireAuth, adminMiddleware, getReportedUsers);
router.put("/user-reports/:reportId", requireAuth, adminMiddleware, updateUserReportStatus);
router.delete("/user-reports/user/:userId", requireAuth, adminMiddleware, banReportedUser);

// ✅ ADMIN PROFILE: Display name & profile photo
router.get("/profile", requireAuth, adminMiddleware, getAdminProfile);
router.put("/profile", requireAuth, adminMiddleware, upload.single("profilePic"), updateAdminProfile);

export default router;
