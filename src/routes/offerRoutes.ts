import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";
import {
  adminCreateOffer,
  adminGetOfferApplications,
  adminListOffers,
  adminRefreshOfferApplicationEligibility,
  adminReviewOfferApplication,
  adminToggleOffer,
  adminUpdateOffer,
  applyForOffer,
  getActiveOffers,
  getMyOfferApplications,
  getOfferById,
  getOfferEligibility,
} from "../controllers/offerController.js";

const router = Router();

// Public / client discovery
router.get("/active", getActiveOffers);

// Admin management
router.get("/admin/list", requireAuth, adminMiddleware, adminListOffers);
router.post("/admin", requireAuth, adminMiddleware, adminCreateOffer);
router.put("/admin/:offerId", requireAuth, adminMiddleware, adminUpdateOffer);
router.patch("/admin/:offerId/toggle", requireAuth, adminMiddleware, adminToggleOffer);
router.get("/admin/:offerId/applications", requireAuth, adminMiddleware, adminGetOfferApplications);
router.get(
  "/admin/:offerId/applications/:applicationId/eligibility",
  requireAuth,
  adminMiddleware,
  adminRefreshOfferApplicationEligibility
);
router.patch(
  "/admin/:offerId/applications/:applicationId",
  requireAuth,
  adminMiddleware,
  adminReviewOfferApplication
);

// User participation
router.get("/my-applications", requireAuth, getMyOfferApplications);
router.get("/:offerId/eligibility", requireAuth, getOfferEligibility);
router.post("/:offerId/apply", requireAuth, applyForOffer);
router.get("/:offerId", getOfferById);

export default router;
