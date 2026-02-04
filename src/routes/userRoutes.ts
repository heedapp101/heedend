import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { 
  followUser, 
  unfollowUser, 
  checkFollowStatus,
  getUserProfile,
  getCurrentUser,
  createCollection,
  toggleCollectionItem,
  updateUserProfile,
  getFollowersList,
  getFollowingList,
  savePushToken,
  removePushToken
} from "../controllers/userController.js";

const router = Router();

// Get current authenticated user (for token validation)
router.get("/me", requireAuth, getCurrentUser);

router.get("/profile/:id", getUserProfile);
router.put("/profile", requireAuth, updateUserProfile);
router.post("/follow/:id", requireAuth, followUser);
router.post("/unfollow/:id", requireAuth, unfollowUser);
router.get("/follow-status/:id", requireAuth, checkFollowStatus);
router.get("/:id/followers", requireAuth, getFollowersList);
router.get("/:id/following", requireAuth, getFollowingList);

// Push notification tokens
router.post("/push-token", requireAuth, savePushToken);
router.delete("/push-token", requireAuth, removePushToken);

router.post("/collections", requireAuth, createCollection);
router.post("/collections/:collectionId/toggle", requireAuth, toggleCollectionItem);

export default router;