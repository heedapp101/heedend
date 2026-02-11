import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";
import {
  getRequiredLegalDocs,
  getLegalDocBySlug,
  getPendingLegalDocs,
  acceptLegalDocs,
  listLegalDocs,
  createLegalDoc,
  updateLegalDoc,
  toggleLegalDoc,
} from "../controllers/legalController.js";

const router = express.Router();

// Public
router.get("/required", getRequiredLegalDocs);
router.get("/doc/:slug", getLegalDocBySlug);

// Authenticated
router.get("/pending", requireAuth, getPendingLegalDocs);
router.post("/accept", requireAuth, acceptLegalDocs);

// Admin
router.get("/admin", requireAuth, adminMiddleware, listLegalDocs);
router.post("/admin", requireAuth, adminMiddleware, createLegalDoc);
router.put("/admin/:id", requireAuth, adminMiddleware, updateLegalDoc);
router.patch("/admin/:id/toggle", requireAuth, adminMiddleware, toggleLegalDoc);

export default router;
