import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  createOrder,
  getMyOrders,
  getOrderById,
  cancelOrder,
  requestRefund,
  getSellerOrders,
  updateOrderStatus,
  addSellerNotes,
  verifyPayment,
  getSellerStats,
  confirmDelivery,
  autoConfirmDeliveries,
} from "../controllers/orderController.js";

const router = express.Router();

// ==================== SELLER ROUTES (must be before :orderId) ====================
// Get seller's orders (dashboard)
router.get("/seller/orders", requireAuth, getSellerOrders);

// Get seller stats
router.get("/seller/stats", requireAuth, getSellerStats);

// ==================== ADMIN/CRON ROUTES ====================
// Auto-confirm old deliveries (for cron job)
router.post("/auto-confirm-deliveries", requireAuth, autoConfirmDeliveries);

// ==================== BUYER ROUTES ====================
// Create new order
router.post("/", requireAuth, createOrder);

// Get buyer's orders
router.get("/my-orders", requireAuth, getMyOrders);

// Get single order details (must be after /seller/* routes)
router.get("/:orderId", requireAuth, getOrderById);

// Cancel order
router.post("/:orderId/cancel", requireAuth, cancelOrder);

// Request refund
router.post("/:orderId/refund", requireAuth, requestRefund);

// Confirm delivery (buyer confirms they received the order)
router.post("/:orderId/confirm-delivery", requireAuth, confirmDelivery);

// Verify payment (for online payments)
router.post("/:orderId/verify-payment", requireAuth, verifyPayment);

// Update order status
router.patch("/:orderId/status", requireAuth, updateOrderStatus);

// Add seller notes
router.patch("/:orderId/notes", requireAuth, addSellerNotes);

export default router;
