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
  getMyPaymentDetails,
  updatePaymentDetails,
  getSellerPaymentDetails,
  getFollowersList,
  getFollowingList,
  savePushToken,
  removePushToken,
  deleteMyAccount,
  reportUser,
  getAwardPaymentMethod,
  updateAwardPaymentMethod,
} from "../controllers/userController.js";

const router = Router();

// Get current authenticated user (for token validation)
router.get("/me", requireAuth, getCurrentUser);

router.get("/profile/:id", getUserProfile);
router.put("/profile", requireAuth, updateUserProfile);
router.get("/payment-details", requireAuth, getMyPaymentDetails);
router.put("/payment-details", requireAuth, updatePaymentDetails);
router.get("/payment-details/:id", requireAuth, getSellerPaymentDetails);

// Award payment method routes
router.get("/award-payment", requireAuth, getAwardPaymentMethod);
router.put("/award-payment", requireAuth, updateAwardPaymentMethod);

router.post("/follow/:id", requireAuth, followUser);
router.post("/unfollow/:id", requireAuth, unfollowUser);
router.get("/follow-status/:id", requireAuth, checkFollowStatus);
router.get("/:id/followers", requireAuth, getFollowersList);
router.get("/:id/following", requireAuth, getFollowingList);

// Push notification tokens
router.post("/push-token", requireAuth, savePushToken);
router.delete("/push-token", requireAuth, removePushToken);
router.delete("/me", requireAuth, deleteMyAccount);

router.post("/collections", requireAuth, createCollection);
router.post("/collections/:collectionId/toggle", requireAuth, toggleCollectionItem);
router.post("/:id/report", requireAuth, reportUser);

export default router;
