import express from "express";
import { submitContactForm, getContactMessages } from "../controllers/contactController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public route - anyone can submit contact form
router.post("/", submitContactForm);

// Admin only - view contact messages
router.get("/messages", protect, adminOnly, getContactMessages);

export default router;
