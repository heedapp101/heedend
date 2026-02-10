import express from "express";
import { submitContactForm, getContactMessages } from "../controllers/contactController.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";

const router = express.Router();

// Public route - anyone can submit contact form
router.post("/", submitContactForm);

// Admin only - view contact messages
router.get("/messages", requireAuth, adminMiddleware, getContactMessages);

export default router;
