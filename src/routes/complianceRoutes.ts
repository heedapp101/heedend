import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import {
  getErrorLogs,
  getErrorById,
  resolveError,
  deleteErrors,
  getErrorStats,
  getEmailConfiguration,
  updateEmailConfiguration,
  addEmailRecipient,
  updateEmailRecipient,
  removeEmailRecipient,
  testEmailConfiguration,
  manualLogError,
} from "../controllers/complianceController.js";

const router = express.Router();

// All routes require admin authentication
router.use(requireAuth);
router.use(requireRole("admin"));

// ==================== ERROR LOGS ====================
// Get all error logs with filtering
router.get("/errors", getErrorLogs);

// Get error statistics
router.get("/stats", getErrorStats);

// Get single error
router.get("/errors/:errorId", getErrorById);

// Resolve/unresolve error
router.patch("/errors/:errorId/resolve", resolveError);

// Delete errors (bulk or single)
router.delete("/errors", deleteErrors);

// Manually log an error (for testing)
router.post("/errors/manual", manualLogError);

// ==================== EMAIL CONFIGURATION ====================
// Get email config
router.get("/email-config", getEmailConfiguration);

// Update email config
router.put("/email-config", updateEmailConfiguration);

// Add recipient
router.post("/email-config/recipients", addEmailRecipient);

// Update recipient
router.patch("/email-config/recipients/:email", updateEmailRecipient);

// Remove recipient
router.delete("/email-config/recipients/:email", removeEmailRecipient);

// Send test email
router.post("/email-config/test", testEmailConfiguration);

export default router;
