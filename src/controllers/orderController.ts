import { Request, Response } from "express";
import Order, { OrderStatus, PaymentMethod } from "../models/Order.js";
import ImagePost from "../models/ImagePost.js";
import User from "../models/User.js";
import { Chat } from "../models/Chat.js";
import Message, { IMessage } from "../models/Message.js";
import OrderCounter from "../models/OrderCounter.js";
import mongoose, { Types } from "mongoose";
import { notifyOrderStatus, createNotification } from "../utils/notificationService.js";
import {
  emitChatNotificationToUsers,
  emitMessageToChat,
} from "../socket/socketHandler.js";

interface AuthRequest extends Request {
  user?: { _id: Types.ObjectId; username?: string };
}

// Generate unique order number: HEESZO-YYYYMMDD-XXXXX
// Uses atomic counter to avoid race conditions
const generateOrderNumber = async (): Promise<string> => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  const counter = await OrderCounter.findOneAndUpdate(
    { date: dateStr },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const sequenceNum = String(counter.seq).padStart(5, '0');
  return `HEESZO-${dateStr}-${sequenceNum}`;
};

// Status labels for user-friendly messages
const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  shipping_initiated: "Shipping Initiated",
  shipped: "Shipped",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  disputed: "Disputed",
  refund_requested: "Refund Requested",
  refunded: "Refunded",
};

// Helper: Get or create chat between buyer and seller
const getOrCreateOrderChat = async (
  buyerId: Types.ObjectId,
  sellerId: Types.ObjectId
): Promise<mongoose.Document | null> => {
  try {
    let chat = await Chat.findOne({
      participants: { $all: [buyerId, sellerId] },
      isActive: true,
    });

    if (!chat) {
      chat = new Chat({
        participants: [buyerId, sellerId],
        chatType: "business",
        isActive: true,
      });
      await chat.save();
    }

    return chat;
  } catch (error) {
    console.error("Error getting/creating chat:", error);
    return null;
  }
};

const toIdString = (value: any): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return String(value);
};

const emitOrderChatMessage = (
  chat: any,
  senderId: string,
  message: IMessage
) => {
  const chatId = toIdString(chat?._id);
  if (!chatId) return;

  const payloadMessage = {
    ...message,
    _id: toIdString((message as any)._id),
    sender: { _id: senderId },
    product: (message as any).product
      ? {
          ...(message as any).product,
          postId: toIdString((message as any).product.postId),
        }
      : undefined,
  };

  emitMessageToChat(chatId, {
    chatId,
    message: payloadMessage,
  });

  const participants = (chat?.participants || []).map((p: any) => toIdString(p));
  emitChatNotificationToUsers(participants, senderId, {
    chatId,
    message: payloadMessage,
    from: senderId,
  });
};

const sendPurchaseMessage = async (params: {
  buyerId: Types.ObjectId;
  sellerId: Types.ObjectId;
  postId: Types.ObjectId;
  title: string;
  unitPrice: number;
  image: string;
  quantity: number;
  remainingStock?: number | null;
}) => {
  try {
    const chat = await getOrCreateOrderChat(params.buyerId, params.sellerId);
    if (!chat) return null;

    const typedChat = chat as any;
    const stockSuffix =
      typeof params.remainingStock === "number"
        ? ` | Stock left: ${Math.max(0, params.remainingStock)}`
        : "";
    const content = `Order placed: ${params.quantity} x ${params.title}${stockSuffix}`;

    const purchaseMessage: IMessage = {
      _id: new Types.ObjectId(),
      chat: typedChat._id,
      sender: new Types.ObjectId(params.buyerId),
      content,
      messageType: "product",
      product: {
        postId: new Types.ObjectId(params.postId),
        title: params.title,
        price: params.unitPrice,
        image: params.image,
      },
      isRead: false,
      createdAt: new Date(),
    } as IMessage;

    const savedPurchaseMessage = await Message.create(purchaseMessage);
    typedChat.lastMessage = {
      content,
      sender: new Types.ObjectId(params.buyerId),
      createdAt: new Date(),
    };
    await typedChat.save();

    emitOrderChatMessage(typedChat, params.buyerId.toString(), savedPurchaseMessage.toObject());
    return typedChat;
  } catch (error) {
    console.error("Error sending purchase message:", error);
    return null;
  }
};

// Helper: Send dispute-window message (auto-deletes after 24 hours)
const sendDisputeWindowMessage = async (
  senderId: Types.ObjectId,
  receiverId: Types.ObjectId,
  orderNumber: string,
  orderId: Types.ObjectId,
  itemName?: string
): Promise<void> => {
  try {
    const chat = await getOrCreateOrderChat(senderId, receiverId);
    if (!chat) return;

    const typedChat = chat as any;
    const orderLabel = itemName ? `"${itemName}" (Order #${orderNumber})` : `Order #${orderNumber}`;
    const content = `⚠️ If you have any issues with ${orderLabel}, you can raise a dispute within 24 hours.`;

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

    const disputeMessage: IMessage = {
      _id: new Types.ObjectId(),
      chat: typedChat._id,
      sender: senderId,
      content,
      messageType: "dispute",
      disputeInfo: {
        orderId,
        orderNumber,
        itemName,
      },
      expiresAt,
      isRead: false,
      createdAt: new Date(),
    } as IMessage;

    const savedMessage = await Message.create(disputeMessage);
    // Don't update lastMessage for dispute messages to avoid clutter
    emitOrderChatMessage(typedChat, senderId.toString(), savedMessage.toObject());
  } catch (error) {
    console.error("Error sending dispute window message:", error);
  }
};

// Helper: Send order update message to chat
const sendOrderUpdateMessage = async (
  senderId: Types.ObjectId,
  receiverId: Types.ObjectId,
  orderNumber: string,
  orderId: Types.ObjectId,
  newStatus: OrderStatus,
  previousStatus: OrderStatus,
  options?: {
    trackingNumber?: string;
    trackingLink?: string;
    estimatedDelivery?: Date;
    isDeliveryConfirmation?: boolean;
    itemName?: string;
  }
): Promise<void> => {
  try {
    const chat = await getOrCreateOrderChat(senderId, receiverId);
    if (!chat) return;

    const typedChat = chat as any;
    const productLabel = options?.itemName ? `"${options.itemName}"` : "";
    const orderLabel = productLabel ? `${productLabel} (Order #${orderNumber})` : `Order #${orderNumber}`;

    let content: string;
    let messageType: "order-update" | "delivery-confirmation" = "order-update";

    if (options?.isDeliveryConfirmation) {
      messageType = "delivery-confirmation";
      content = `📦 Your order ${orderLabel} has been marked as delivered! Please confirm if you received your order. If no response, it will be auto-confirmed in 48 hours.`;
    } else {
      // Generate user-friendly message based on status
      switch (newStatus) {
        case "confirmed":
          content = `✅ Great news! Your order ${orderLabel} has been confirmed by the seller.`;
          break;
        case "processing":
          content = `🔧 Your order ${orderLabel} is now being processed and prepared for shipping.`;
          break;
        case "shipping_initiated":
          content = `📦 Your order ${orderLabel} shipping has been initiated! The seller is preparing to ship your order. Cancellation is no longer available.`;
          break;
        case "shipped":
          content = `🚚 Your order ${orderLabel} has been shipped!${options?.trackingNumber ? ` Tracking: ${options.trackingNumber}` : ""}${options?.estimatedDelivery ? `\n📅 Estimated delivery: ${new Date(options.estimatedDelivery).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}${options?.trackingLink ? `\n📎 Track here: ${options.trackingLink}` : ""}`;
          break;
        case "out_for_delivery":
          content = `📍 Your order ${orderLabel} is out for delivery! It should arrive today.`;
          break;
        case "delivered":
          content = `🎉 Your order ${orderLabel} has been delivered! Thank you for shopping with us.`;
          break;
        case "cancelled":
          content = `❌ Your order ${orderLabel} has been cancelled.`;
          break;
        case "disputed":
          content = `⚠️ A dispute has been raised for order ${orderLabel}. Our team will review this shortly.`;
          break;
        default:
          content = `📋 ${orderLabel} status updated to ${ORDER_STATUS_LABELS[newStatus]}.`;
      }
    }

    const newMessage: IMessage = {
      _id: new Types.ObjectId(),
      chat: typedChat._id,
      sender: senderId,
      content,
      messageType,
      orderUpdate: messageType === "order-update" ? {
        orderId,
        orderNumber,
        status: newStatus,
        previousStatus,
        trackingNumber: options?.trackingNumber,
        trackingLink: options?.trackingLink,
        estimatedDelivery: options?.estimatedDelivery,
      } : undefined,
      deliveryConfirmation: messageType === "delivery-confirmation" ? {
        orderId,
        orderNumber,
        confirmed: false,
      } : undefined,
      isRead: false,
      createdAt: new Date(),
    } as IMessage;

    const savedMessage = await Message.create(newMessage);
    typedChat.lastMessage = {
      content: messageType === "delivery-confirmation" ? "📦 Delivery confirmation request" : `📋 Order update: ${ORDER_STATUS_LABELS[newStatus]}`,
      sender: senderId,
      createdAt: new Date(),
    };

    await typedChat.save();
    emitOrderChatMessage(typedChat, senderId.toString(), savedMessage.toObject());
  } catch (error) {
    console.error("Error sending order update message:", error);
    // Don't throw - message sending failure shouldn't break the order update
  }
};

// ==================== BUYER OPERATIONS ====================

/**
 * Create a new order
 * POST /api/orders
 */
export const createOrder = async (req: AuthRequest, res: Response) => {
  try {
    const buyerId = req.user?._id;
    const {
      postId,
      quantity = 1,
      paymentMethod,
      shippingAddress,
      buyerNotes,
      chatId,
      selectedSize,
    } = req.body;
    if (!buyerId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const validChatId =
      chatId && mongoose.Types.ObjectId.isValid(String(chatId))
        ? new mongoose.Types.ObjectId(String(chatId))
        : undefined;

    // Validate required fields
    if (!postId || !paymentMethod || !shippingAddress) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({ message: "Quantity must be a positive integer" });
    }

    // Validate payment method
    if (!["cod", "online"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    // Get the product
    const post = await ImagePost.findById(postId).populate(
      "user",
      "username name cashOnDeliveryAvailable inventoryAlertThreshold"
    );
    if (!post) {
      return res.status(404).json({ message: "Product not found" });
    }

    const seller = post.user as any;
    const sizeVariants = (post as any).sizeVariants || [];
    const hasSizeVariants = Array.isArray(sizeVariants) && sizeVariants.length > 0;
    const hasManagedInventory = typeof (post as any).quantityAvailable === "number";
    const currentQuantity = hasManagedInventory ? Number((post as any).quantityAvailable) : null;

    // Prevent buying own product
    if (seller._id.toString() === buyerId?.toString()) {
      return res.status(400).json({ message: "Cannot buy your own product" });
    }

    // Size variant validation
    let matchedVariant: any = null;
    let unitPrice = post.price || 0;

    if (hasSizeVariants) {
      if (!selectedSize) {
        return res.status(400).json({ message: "Please select a size" });
      }
      matchedVariant = sizeVariants.find((v: any) => v.size === selectedSize);
      if (!matchedVariant) {
        return res.status(400).json({ message: `Size "${selectedSize}" is not available` });
      }
      if (matchedVariant.quantity <= 0) {
        return res.status(400).json({ message: `Size "${selectedSize}" is out of stock` });
      }
      if (parsedQuantity > matchedVariant.quantity) {
        return res.status(400).json({
          message: `Only ${matchedVariant.quantity} item(s) available in size "${selectedSize}"`,
          availableQuantity: matchedVariant.quantity,
        });
      }
      unitPrice = matchedVariant.price;
    } else {
      if ((post as any).isOutOfStock === true || (hasManagedInventory && currentQuantity !== null && currentQuantity <= 0)) {
        return res.status(400).json({ message: "This product is out of stock" });
      }

      if (hasManagedInventory && currentQuantity !== null && parsedQuantity > currentQuantity) {
        return res.status(400).json({
          message: `Only ${currentQuantity} item(s) available in stock`,
          availableQuantity: currentQuantity,
        });
      }
    }

    // Check if COD is available for this seller
    if (paymentMethod === "cod" && !seller.cashOnDeliveryAvailable) {
      return res.status(400).json({ message: "Cash on Delivery is not available for this seller" });
    }

    // Calculate pricing
    const subtotal = unitPrice * parsedQuantity;
    const shippingCharge = subtotal >= 500 ? 0 : 50; // Free shipping above ₹500
    const discount = 0; // Can add coupon system later
    const totalAmount = subtotal + shippingCharge - discount;

    // Create order item
    const orderItem: any = {
      post: post._id,
      title: post.title + (selectedSize ? ` (${selectedSize})` : ''),
      price: unitPrice,
      quantity: parsedQuantity,
      image: post.images[0]?.low || post.images[0]?.high || "",
    };
    if (selectedSize) {
      orderItem.selectedSize = selectedSize;
    }

    // Generate order number
    const orderNumber = await generateOrderNumber();

    // Create order
    const order = new Order({
      orderNumber,
      buyer: buyerId,
      seller: seller._id,
      items: [orderItem],
      subtotal,
      shippingCharge,
      discount,
      totalAmount,
      paymentMethod,
      paymentStatus: paymentMethod === "cod" ? "pending" : "pending",
      shippingAddress,
      buyerNotes,
      chatId: validChatId,
      status: "pending",
    });

    await order.save();

    // Reduce inventory when quantity tracking is enabled for the post
    if (hasSizeVariants && matchedVariant) {
      // Reduce size variant quantity
      matchedVariant.quantity = Math.max(0, matchedVariant.quantity - parsedQuantity);
      // Recompute overall stock  
      const totalQty = sizeVariants.reduce((sum: number, v: any) => sum + v.quantity, 0);
      (post as any).quantityAvailable = totalQty;
      (post as any).isOutOfStock = totalQty === 0;
      (post as any).sizeVariants = sizeVariants;
      await post.save();

      const threshold = Number(seller.inventoryAlertThreshold || 3);
      if (totalQty === 0) {
        await createNotification({
          recipientId: seller._id.toString(),
          type: "system",
          title: "Inventory Empty",
          message: `"${post.title}" is now out of stock (all sizes).`,
          postId: post._id.toString(),
          metadata: { postId: post._id.toString(), quantityAvailable: 0 },
        });
      } else if (matchedVariant.quantity === 0) {
        await createNotification({
          recipientId: seller._id.toString(),
          type: "system",
          title: "Size Out of Stock",
          message: `"${post.title}" size "${selectedSize}" is now out of stock.`,
          postId: post._id.toString(),
          metadata: { postId: post._id.toString(), size: selectedSize, quantityAvailable: 0 },
        });
      } else if (matchedVariant.quantity <= threshold) {
        await createNotification({
          recipientId: seller._id.toString(),
          type: "system",
          title: "Low Inventory Alert",
          message: `"${post.title}" size "${selectedSize}" is running low (${matchedVariant.quantity} left).`,
          postId: post._id.toString(),
          metadata: { postId: post._id.toString(), size: selectedSize, quantityAvailable: matchedVariant.quantity },
        });
      }
    } else if (hasManagedInventory && currentQuantity !== null) {
      const nextQuantity = Math.max(0, currentQuantity - parsedQuantity);
      (post as any).quantityAvailable = nextQuantity;
      (post as any).isOutOfStock = nextQuantity === 0;
      await post.save();

      // Notify seller if stock is low or exhausted
      const threshold = Number(seller.inventoryAlertThreshold || 3);
      if (nextQuantity === 0) {
        await createNotification({
          recipientId: seller._id.toString(),
          type: "system",
          title: "Inventory Empty",
          message: `"${post.title}" is now out of stock.`,
          postId: post._id.toString(),
          metadata: { postId: post._id.toString(), quantityAvailable: 0 },
        });
      } else if (nextQuantity <= threshold) {
        await createNotification({
          recipientId: seller._id.toString(),
          type: "system",
          title: "Low Inventory Alert",
          message: `"${post.title}" is running low (${nextQuantity} left).`,
          postId: post._id.toString(),
          metadata: { postId: post._id.toString(), quantityAvailable: nextQuantity },
        });
      }
    }

    const remainingStock =
      typeof (post as any).quantityAvailable === "number"
        ? Number((post as any).quantityAvailable)
        : null;
    const purchaseChat = await sendPurchaseMessage({
      buyerId: new Types.ObjectId(buyerId),
      sellerId: new Types.ObjectId(seller._id),
      postId: new Types.ObjectId(post._id),
      title: post.title,
      unitPrice: post.price || 0,
      image: post.images[0]?.low || post.images[0]?.high || "",
      quantity: parsedQuantity,
      remainingStock,
    });
    if (purchaseChat && (!order.chatId || order.chatId.toString() !== purchaseChat._id.toString())) {
      order.chatId = purchaseChat._id;
      await order.save();
    }

    // Populate for response
    const populatedOrder = await Order.findById(order._id)
      .populate("buyer", "username name phone profilePic")
      .populate("seller", "username name phone profilePic companyName")
      .populate("items.post", "title images price");

    // 🔔 Send notification to seller about new order
    await notifyOrderStatus(
      seller._id.toString(),
      order._id.toString(),
      orderNumber,
      "pending",
      false // isBuyer = false (this goes to seller)
    );

    // 🔔 Send confirmation notification to buyer
    if (buyerId) {
      await notifyOrderStatus(
        buyerId.toString(),
        order._id.toString(),
        orderNumber,
        "pending",
        true // isBuyer = true
      );
    }

    res.status(201).json({
      message: "Order placed successfully",
      order: populatedOrder,
    });
  } catch (error: any) {
    console.error("Create order error:", error);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
};

/**
 * Get orders between current user and another user (for chat pinned order)
 * GET /api/orders/between/:userId
 */
export const getOrdersBetweenUsers = async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?._id;
    const { userId } = req.params;

    if (!currentUserId || !userId) {
      return res.status(400).json({ message: "Missing user information" });
    }

    // Find orders where current user is buyer and other is seller, or vice versa
    const orders = await Order.find({
      $or: [
        { buyer: currentUserId, seller: userId },
        { buyer: userId, seller: currentUserId },
      ],
      status: { $nin: ["cancelled", "refunded"] },
    })
      .populate("buyer", "username name profilePic")
      .populate("seller", "username name profilePic companyName")
      .populate("items.post", "title images price")
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({ orders });
  } catch (error: any) {
    console.error("Get orders between users error:", error);
    res.status(500).json({ message: "Failed to fetch orders", error: error.message });
  }
};

/**
 * Get buyer's orders
 * GET /api/orders/my-orders
 */
export const getMyOrders = async (req: AuthRequest, res: Response) => {
  try {
    const buyerId = req.user?._id;
    const { status, page = 1, limit = 20 } = req.query;

    const query: any = { buyer: buyerId };
    if (status && status !== 'all') {
      const statuses = (status as string).split(',').map(s => s.trim());
      query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate("seller", "username name profilePic companyName")
        .populate("items.post", "title images")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Order.countDocuments(query),
    ]);

    res.json({
      orders,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error: any) {
    console.error("Get my orders error:", error);
    res.status(500).json({ message: "Failed to fetch orders", error: error.message });
  }
};

/**
 * Get single order details
 * GET /api/orders/:orderId
 */
export const getOrderById = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;

    const order = await Order.findById(orderId)
      .populate("buyer", "username name phone email profilePic")
      .populate("seller", "username name phone email profilePic companyName address")
      .populate("items.post", "title images price description");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Only buyer or seller can view order
    if (order.buyer._id.toString() !== userId?.toString() && order.seller._id.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized to view this order" });
    }

    res.json(order);
  } catch (error: any) {
    console.error("Get order error:", error);
    res.status(500).json({ message: "Failed to fetch order", error: error.message });
  }
};

/**
 * Cancel order (buyer)
 * POST /api/orders/:orderId/cancel
 */
export const cancelOrder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Only buyer can cancel
    if (order.buyer.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }

    // Can only cancel if not yet shipping_initiated
    const cancellableStatuses: OrderStatus[] = ["pending", "confirmed", "processing"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ 
        message: order.status === "shipping_initiated" 
          ? "Order cannot be cancelled after shipping has been initiated."
          : "Order cannot be cancelled at this stage. Please request a refund instead." 
      });
    }

    const cancellationWindowMs = 24 * 60 * 60 * 1000;
    const placedAt = order.createdAt ? new Date(order.createdAt) : null;
    if (!placedAt || Date.now() - placedAt.getTime() > cancellationWindowMs) {
      return res.status(400).json({
        message: "Order cannot be cancelled after 24 hours of placement.",
      });
    }

    order.status = "cancelled";
    order.cancellationReason = reason || "Cancelled by buyer";
    order.cancelledBy = new mongoose.Types.ObjectId(userId);
    order.statusHistory.push({
      status: "cancelled",
      timestamp: new Date(),
      note: reason || "Cancelled by buyer",
      updatedBy: new mongoose.Types.ObjectId(userId),
    });

    // If paid online, mark for refund
    if (order.paymentMethod === "online" && order.paymentStatus === "completed") {
      order.refundAmount = order.totalAmount;
      order.refundReason = "Order cancelled";
    }

    await order.save();

    // Send cancellation message to chat
    const firstItemName = order.items?.[0]?.title || "";
    const itemLabel = order.items?.length > 1 ? `${firstItemName} +${order.items.length - 1} more` : firstItemName;
    await sendOrderUpdateMessage(
      new mongoose.Types.ObjectId(userId),
      order.seller,
      order.orderNumber,
      order._id,
      "cancelled",
      "pending", // previous status doesn't matter much for cancel messages
      { itemName: itemLabel }
    );

    // 🔔 Notify seller about cancellation
    await notifyOrderStatus(
      order.seller.toString(),
      order._id.toString(),
      order.orderNumber,
      "cancelled",
      false // isBuyer = false (notification goes to seller)
    );

    res.json({ message: "Order cancelled successfully", order });
  } catch (error: any) {
    console.error("Cancel order error:", error);
    res.status(500).json({ message: "Failed to cancel order", error: error.message });
  }
};

/**
 * Request refund (buyer)
 * POST /api/orders/:orderId/refund
 */
export const requestRefund = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.buyer.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Can request refund only if delivered
    if (order.status !== "delivered") {
      return res.status(400).json({ message: "Can only request refund for delivered orders" });
    }

    order.status = "refund_requested";
    order.refundReason = reason;
    order.refundAmount = order.totalAmount;
    order.statusHistory.push({
      status: "refund_requested",
      timestamp: new Date(),
      note: reason,
      updatedBy: new mongoose.Types.ObjectId(userId),
    });

    await order.save();

    res.json({ message: "Refund requested", order });
  } catch (error: any) {
    console.error("Request refund error:", error);
    res.status(500).json({ message: "Failed to request refund", error: error.message });
  }
};

/**
 * Dispute order (buyer) — 24hr window after delivery
 * POST /api/orders/:orderId/dispute
 */
export const disputeOrder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.buyer.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Can only dispute if delivered
    if (order.status !== "delivered") {
      return res.status(400).json({ message: "Can only dispute delivered orders" });
    }

    // 24-hour window check
    if (order.deliveredAt) {
      const deliveredTime = new Date(order.deliveredAt).getTime();
      const disputeDeadline = deliveredTime + 24 * 60 * 60 * 1000;
      if (Date.now() > disputeDeadline) {
        return res.status(400).json({
          message: "Dispute window has closed. You can only dispute within 24 hours of delivery.",
        });
      }
    }

    order.status = "disputed";
    (order as any).disputeReason = reason || "Buyer raised a dispute";
    (order as any).disputedAt = new Date();
    order.statusHistory.push({
      status: "disputed",
      timestamp: new Date(),
      note: reason || "Buyer raised a dispute",
      updatedBy: new mongoose.Types.ObjectId(userId),
    });

    await order.save();

    // Send dispute message to chat
    const firstItemName = order.items?.[0]?.title || "";
    const itemLabel = order.items?.length > 1 ? `${firstItemName} +${order.items.length - 1} more` : firstItemName;
    await sendOrderUpdateMessage(
      new mongoose.Types.ObjectId(userId),
      order.seller,
      order.orderNumber,
      order._id,
      "disputed",
      "delivered",
      { itemName: itemLabel }
    );

    // Notify seller about dispute
    await notifyOrderStatus(
      order.seller.toString(),
      order._id.toString(),
      order.orderNumber,
      "disputed",
      false
    );

    res.json({ message: "Dispute raised successfully", order });
  } catch (error: any) {
    console.error("Dispute order error:", error);
    res.status(500).json({ message: "Failed to raise dispute", error: error.message });
  }
};

// ==================== SELLER OPERATIONS ====================

/**
 * Get seller's orders (dashboard)
 * GET /api/orders/seller-orders
 */
export const getSellerOrders = async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.user?._id;
    const { status, page = 1, limit = 20 } = req.query;

    // Convert to ObjectId if it's a string
    const sellerObjectId = typeof sellerId === 'string' 
      ? new mongoose.Types.ObjectId(sellerId) 
      : sellerId;

    const query: any = { seller: sellerObjectId };
    if (status && status !== 'all') {
      const statuses = (status as string).split(',').map(s => s.trim());
      query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [orders, total, stats] = await Promise.all([
      Order.find(query)
        .populate("buyer", "username name phone profilePic")
        .populate("items.post", "title images")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Order.countDocuments(query),
      // Get order stats
      Order.aggregate([
        { $match: { seller: sellerObjectId } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            revenue: { $sum: "$totalAmount" },
          },
        },
      ]),
    ]);

    // Format stats
    const formattedStats = {
      pending: 0,
      confirmed: 0,
      processing: 0,
      shipping_initiated: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 0,
      disputed: 0,
      totalRevenue: 0,
      totalOrders: total,
    };

    stats.forEach((s) => {
      if (s._id in formattedStats) {
        (formattedStats as any)[s._id] = s.count;
      }
      if (["delivered", "shipped", "out_for_delivery", "shipping_initiated"].includes(s._id)) {
        formattedStats.totalRevenue += s.revenue;
      }
    });

    res.json({
      orders,
      stats: formattedStats,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error: any) {
    console.error("Get seller orders error:", error);
    res.status(500).json({ message: "Failed to fetch orders", error: error.message });
  }
};

/**
 * Update order status (seller)
 * PATCH /api/orders/:orderId/status
 */
export const updateOrderStatus = async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.user?._id;
    const { orderId } = req.params;
    const { status, note, trackingNumber, shippingCarrier, estimatedDelivery, trackingLink } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.seller.toString() !== sellerId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Validate status transition
    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      pending: ["confirmed", "cancelled"],
      confirmed: ["shipping_initiated", "cancelled"],
      processing: ["shipping_initiated", "cancelled"],
      shipping_initiated: ["shipped"],
      shipped: ["out_for_delivery", "delivered"],
      out_for_delivery: ["delivered"],
      delivered: ["disputed", "refund_requested"],
      cancelled: [],
      disputed: ["refunded"],
      refund_requested: ["refunded"],
      refunded: [],
    };

    if (!validTransitions[order.status]?.includes(status)) {
      return res.status(400).json({ 
        message: `Cannot transition from ${order.status} to ${status}` 
      });
    }

    // Require tracking number for shipped status
    if (status === "shipped" && !trackingNumber) {
      return res.status(400).json({
        message: "Tracking number is required to mark order as shipped."
      });
    }

    // Store previous status for messaging
    const previousStatus = order.status;

    // Update order
    order.status = status;
    order.statusHistory.push({
      status,
      timestamp: new Date(),
      note,
      updatedBy: new mongoose.Types.ObjectId(sellerId),
    });

    // Update shipping info if provided
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (trackingLink) (order as any).trackingLink = trackingLink;
    if (shippingCarrier) order.shippingCarrier = shippingCarrier;
    if (estimatedDelivery) order.estimatedDelivery = new Date(estimatedDelivery);
    if (status === "delivered") order.deliveredAt = new Date();

    // Update payment status for COD on delivery
    if (status === "delivered" && order.paymentMethod === "cod") {
      order.paymentStatus = "completed";
      order.paidAt = new Date();
    }

    await order.save();

    // Send order update notification via chat
    const firstItemName = order.items?.[0]?.title || "";
    const itemLabel = order.items?.length > 1 ? `${firstItemName} +${order.items.length - 1} more` : firstItemName;
    await sendOrderUpdateMessage(
      new mongoose.Types.ObjectId(sellerId),
      order.buyer,
      order.orderNumber,
      order._id,
      status,
      previousStatus,
      {
        trackingNumber: order.trackingNumber,
        trackingLink: (order as any).trackingLink,
        estimatedDelivery: order.estimatedDelivery,
        isDeliveryConfirmation: status === "delivered" || status === "out_for_delivery",
        itemName: itemLabel,
      }
    );

    // Send dispute window message when order is delivered (auto-deletes after 24h)
    if (status === "delivered") {
      await sendDisputeWindowMessage(
        new mongoose.Types.ObjectId(sellerId),
        order.buyer,
        order.orderNumber,
        order._id,
        itemLabel
      );
    }

    // 🔔 Send notification to buyer about order status change
    await notifyOrderStatus(
      order.buyer.toString(),
      order._id.toString(),
      order.orderNumber,
      status,
      true // isBuyer
    );

    const populatedOrder = await Order.findById(orderId)
      .populate("buyer", "username name phone profilePic")
      .populate("seller", "username name profilePic companyName");

    res.json({ message: "Order status updated", order: populatedOrder });
  } catch (error: any) {
    console.error("Update order status error:", error);
    res.status(500).json({ message: "Failed to update order", error: error.message });
  }
};

/**
 * Add seller notes to order
 * PATCH /api/orders/:orderId/notes
 */
export const addSellerNotes = async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.user?._id;
    const { orderId } = req.params;
    const { notes } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.seller.toString() !== sellerId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    order.sellerNotes = notes;
    await order.save();

    res.json({ message: "Notes updated", order });
  } catch (error: any) {
    console.error("Add seller notes error:", error);
    res.status(500).json({ message: "Failed to update notes", error: error.message });
  }
};

// ==================== PAYMENT OPERATIONS ====================

/**
 * Verify online payment (for Razorpay integration)
 * POST /api/orders/:orderId/verify-payment
 */
export const verifyPayment = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.buyer.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // TODO: Verify Razorpay signature when integrated
    // const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    // if (!isValid) {
    //   return res.status(400).json({ message: "Payment verification failed" });
    // }

    // For now, just mark as completed (remove this when Razorpay is integrated)
    order.paymentStatus = "completed";
    order.transactionId = razorpay_payment_id || `TXN-${Date.now()}`;
    order.paidAt = new Date();

    await order.save();

    res.json({ message: "Payment verified", order });
  } catch (error: any) {
    console.error("Verify payment error:", error);
    res.status(500).json({ message: "Payment verification failed", error: error.message });
  }
};

/**
 * Get order statistics for seller dashboard
 * GET /api/orders/seller-stats
 */
export const getSellerStats = async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.user?._id;

    const stats = await Order.aggregate([
      { $match: { seller: new mongoose.Types.ObjectId(sellerId) } },
      {
        $facet: {
          byStatus: [
            { $group: { _id: "$status", count: { $sum: 1 } } }
          ],
          revenue: [
            { 
              $match: { 
                status: { $in: ["delivered", "shipped", "out_for_delivery"] },
                paymentStatus: "completed"
              } 
            },
            { 
              $group: { 
                _id: null, 
                total: { $sum: "$totalAmount" },
                count: { $sum: 1 }
              } 
            }
          ],
          recentOrders: [
            { $sort: { createdAt: -1 } },
            { $limit: 5 },
            { 
              $lookup: { 
                from: "users", 
                localField: "buyer", 
                foreignField: "_id", 
                as: "buyerInfo" 
              } 
            },
            { $unwind: "$buyerInfo" },
            {
              $project: {
                orderNumber: 1,
                totalAmount: 1,
                status: 1,
                createdAt: 1,
                "buyerInfo.name": 1,
                "buyerInfo.profilePic": 1,
              }
            }
          ],
          pendingActions: [
            { $match: { status: { $in: ["pending", "refund_requested"] } } },
            { $count: "count" }
          ],
        }
      }
    ]);

    const result = stats[0];
    
    // Format response
    const statusCounts: Record<string, number> = {};
    result.byStatus.forEach((s: any) => {
      statusCounts[s._id] = s.count;
    });

    res.json({
      statusCounts,
      revenue: result.revenue[0]?.total || 0,
      completedOrders: result.revenue[0]?.count || 0,
      recentOrders: result.recentOrders,
      pendingActions: result.pendingActions[0]?.count || 0,
    });
  } catch (error: any) {
    console.error("Get seller stats error:", error);
    res.status(500).json({ message: "Failed to fetch stats", error: error.message });
  }
};

// ==================== SELLER ANALYTICS (COMPREHENSIVE) ====================

/**
 * Get comprehensive seller analytics
 * GET /api/orders/seller/analytics?period=30
 */
export const getSellerAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    const sellerId = req.user?._id;
    const period = parseInt(req.query.period as string) || 30; // days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);

    // Previous period for comparison
    const prevStartDate = new Date();
    prevStartDate.setDate(prevStartDate.getDate() - period * 2);

    const sellerObjId = new mongoose.Types.ObjectId(sellerId);

    // ── 1. Revenue & order aggregation ──
    const [currentPeriod] = await Order.aggregate([
      {
        $match: {
          seller: sellerObjId,
          createdAt: { $gte: startDate },
        },
      },
      {
        $facet: {
          // Revenue from completed orders
          revenue: [
            {
              $match: {
                status: { $in: ["delivered", "shipped", "out_for_delivery"] },
                paymentStatus: "completed",
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: "$totalAmount" },
                count: { $sum: 1 },
                avgOrderValue: { $avg: "$totalAmount" },
              },
            },
          ],
          // Total orders this period
          totalOrders: [{ $count: "count" }],
          // Orders by status
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          // Revenue by day (for chart)
          revenueByDay: [
            {
              $match: {
                status: { $in: ["delivered", "shipped", "out_for_delivery"] },
                paymentStatus: "completed",
              },
            },
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                revenue: { $sum: "$totalAmount" },
                orders: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          // Orders by day (for chart)
          ordersByDay: [
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          // Top selling products
          topProducts: [
            { $unwind: "$items" },
            {
              $group: {
                _id: "$items.post",
                title: { $first: "$items.title" },
                image: { $first: "$items.image" },
                totalSold: { $sum: "$items.quantity" },
                totalRevenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
                orderCount: { $sum: 1 },
              },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: 5 },
          ],
          // Payment method breakdown
          paymentMethods: [
            {
              $group: {
                _id: "$paymentMethod",
                count: { $sum: 1 },
                amount: { $sum: "$totalAmount" },
              },
            },
          ],
          // Conversion funnel: pending → confirmed → shipped → delivered
          conversionFunnel: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          // Recent 10 orders
          recentOrders: [
            { $sort: { createdAt: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: "users",
                localField: "buyer",
                foreignField: "_id",
                as: "buyerInfo",
              },
            },
            { $unwind: "$buyerInfo" },
            {
              $project: {
                orderNumber: 1,
                totalAmount: 1,
                status: 1,
                paymentStatus: 1,
                paymentMethod: 1,
                createdAt: 1,
                items: { $size: "$items" },
                "buyerInfo.name": 1,
                "buyerInfo.username": 1,
                "buyerInfo.profilePic": 1,
              },
            },
          ],
        },
      },
    ]);

    // ── 2. Previous period for comparison ──
    const [prevPeriodData] = await Order.aggregate([
      {
        $match: {
          seller: sellerObjId,
          createdAt: { $gte: prevStartDate, $lt: startDate },
        },
      },
      {
        $facet: {
          revenue: [
            {
              $match: {
                status: { $in: ["delivered", "shipped", "out_for_delivery"] },
                paymentStatus: "completed",
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: "$totalAmount" },
                count: { $sum: 1 },
              },
            },
          ],
          totalOrders: [{ $count: "count" }],
        },
      },
    ]);

    // ── 3. Product engagement stats ──
    const productStats = await ImagePost.aggregate([
      { $match: { user: sellerObjId } },
      {
        $group: {
          _id: null,
          totalPosts: { $sum: 1 },
          totalViews: { $sum: { $ifNull: ["$views", 0] } },
          totalLikes: { $sum: { $ifNull: ["$likesCount", 0] } },
          totalComments: { $sum: { $ifNull: ["$commentsCount", 0] } },
          activePosts: {
            $sum: {
              $cond: [{ $eq: ["$isArchived", false] }, 1, 0],
            },
          },
          outOfStock: {
            $sum: {
              $cond: [{ $eq: ["$isOutOfStock", true] }, 1, 0],
            },
          },
          boostedPosts: {
            $sum: {
              $cond: [{ $eq: ["$isBoosted", true] }, 1, 0],
            },
          },
        },
      },
    ]);

    // ── 4. Low stock alerts ──
    const lowStockPosts = await ImagePost.find({
      user: sellerObjId,
      isArchived: { $ne: true },
      quantityAvailable: { $gt: 0, $lte: 5 },
    })
      .select("title quantityAvailable images price")
      .sort({ quantityAvailable: 1 })
      .limit(5)
      .lean();

    // ── Format response ──
    const curr = currentPeriod;
    const currRevenue = curr.revenue[0]?.total || 0;
    const currOrders = curr.totalOrders[0]?.count || 0;
    const prevRevenue = prevPeriodData.revenue[0]?.total || 0;
    const prevOrders = prevPeriodData.totalOrders[0]?.count || 0;

    const revenueGrowth = prevRevenue > 0 ? ((currRevenue - prevRevenue) / prevRevenue) * 100 : currRevenue > 0 ? 100 : 0;
    const ordersGrowth = prevOrders > 0 ? ((currOrders - prevOrders) / prevOrders) * 100 : currOrders > 0 ? 100 : 0;

    const statusCounts: Record<string, number> = {};
    curr.byStatus.forEach((s: any) => {
      statusCounts[s._id] = s.count;
    });

    const engagement = productStats[0] || {
      totalPosts: 0,
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      activePosts: 0,
      outOfStock: 0,
      boostedPosts: 0,
    };

    res.json({
      period,
      overview: {
        revenue: currRevenue,
        revenueGrowth: Math.round(revenueGrowth * 10) / 10,
        totalOrders: currOrders,
        ordersGrowth: Math.round(ordersGrowth * 10) / 10,
        completedOrders: curr.revenue[0]?.count || 0,
        avgOrderValue: Math.round(curr.revenue[0]?.avgOrderValue || 0),
        pendingOrders: (statusCounts["pending"] || 0) + (statusCounts["refund_requested"] || 0),
      },
      statusCounts,
      charts: {
        revenueByDay: curr.revenueByDay.map((d: any) => ({
          date: d._id,
          revenue: d.revenue,
          orders: d.orders,
        })),
        ordersByDay: curr.ordersByDay.map((d: any) => ({
          date: d._id,
          orders: d.count,
        })),
      },
      topProducts: curr.topProducts.map((p: any) => ({
        id: p._id,
        title: p.title,
        image: p.image,
        totalSold: p.totalSold,
        totalRevenue: p.totalRevenue,
        orderCount: p.orderCount,
      })),
      paymentMethods: curr.paymentMethods.map((p: any) => ({
        method: p._id,
        count: p.count,
        amount: p.amount,
      })),
      engagement,
      lowStockAlerts: lowStockPosts.map((p: any) => ({
        id: p._id,
        title: p.title,
        stock: p.quantityAvailable,
        image: p.images?.[0]?.low || p.images?.[0]?.high,
        price: p.price,
      })),
      recentOrders: curr.recentOrders,
    });
  } catch (error: any) {
    console.error("Get seller analytics error:", error);
    res.status(500).json({ message: "Failed to fetch analytics", error: error.message });
  }
};

// ==================== DELIVERY CONFIRMATION ====================

/**
 * Confirm delivery (buyer)
 * POST /api/orders/:orderId/confirm-delivery
 */
export const confirmDelivery = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { orderId } = req.params;
    const { confirmed } = req.body; // true = yes delivered, false = not received

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Only buyer can confirm delivery
    if (order.buyer.toString() !== userId?.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Can only confirm if status is delivered or out_for_delivery
    if (!["delivered", "out_for_delivery"].includes(order.status)) {
      return res.status(400).json({ 
        message: "Can only confirm delivery for orders marked as delivered or out for delivery" 
      });
    }

    if (confirmed) {
      // User confirmed receiving the order
      order.status = "delivered";
      order.deliveredAt = new Date();
      order.statusHistory.push({
        status: "delivered",
        timestamp: new Date(),
        note: "Delivery confirmed by buyer",
        updatedBy: new mongoose.Types.ObjectId(userId),
      });

      // Update payment status for COD
      if (order.paymentMethod === "cod") {
        order.paymentStatus = "completed";
        order.paidAt = new Date();
      }

      await order.save();

      // Update delivery confirmation in chat
      await updateDeliveryConfirmationInChat(
        order.buyer,
        order.seller,
        order._id,
        true
      );

      res.json({ 
        message: "Delivery confirmed! Thank you for your order.", 
        order 
      });
    } else {
      // User says not received - mark for investigation
      order.statusHistory.push({
        status: order.status,
        timestamp: new Date(),
        note: "Buyer reported not receiving the order",
        updatedBy: new mongoose.Types.ObjectId(userId),
      });
      await order.save();

      // Update delivery confirmation in chat
      await updateDeliveryConfirmationInChat(
        order.buyer,
        order.seller,
        order._id,
        false
      );

      // Send message to seller about the issue
      await sendOrderUpdateMessage(
        order.buyer,
        order.seller,
        order.orderNumber,
        order._id,
        order.status,
        order.status,
        { isDeliveryConfirmation: false }
      );

      res.json({ 
        message: "We've notified the seller. They will contact you soon.", 
        order 
      });
    }
  } catch (error: any) {
    console.error("Confirm delivery error:", error);
    res.status(500).json({ message: "Failed to confirm delivery", error: error.message });
  }
};

// Helper: Update delivery confirmation status in chat
const updateDeliveryConfirmationInChat = async (
  buyerId: Types.ObjectId,
  sellerId: Types.ObjectId,
  orderId: Types.ObjectId,
  confirmed: boolean
): Promise<void> => {
  try {
    // Find chat between buyer and seller
    const chat = await Chat.findOne({
      participants: { $all: [buyerId, sellerId] },
      isActive: true,
    });

    if (!chat) return;

    const confirmationMsg = await Message.findOne({
      chat: chat._id,
      messageType: "delivery-confirmation",
      "deliveryConfirmation.orderId": orderId,
    }).sort({ createdAt: -1 });

    if (
      confirmationMsg &&
      confirmationMsg.deliveryConfirmation?.orderId &&
      confirmationMsg.deliveryConfirmation?.orderNumber
    ) {
      confirmationMsg.deliveryConfirmation = {
        orderId: confirmationMsg.deliveryConfirmation.orderId,
        orderNumber: confirmationMsg.deliveryConfirmation.orderNumber,
        confirmed,
        confirmedAt: new Date(),
      };
      await confirmationMsg.save();
    }
  } catch (error) {
    console.error("Error updating delivery confirmation:", error);
  }
};

/**
 * Auto-confirm delivery (cron job endpoint or scheduled task)
 * This can be called by a cron job to auto-confirm deliveries after 48 hours
 * POST /api/orders/auto-confirm-deliveries (admin only)
 */
export const autoConfirmDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    // This should be admin-only or called by a cron service
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const orders = await Order.find({
      status: "out_for_delivery",
      updatedAt: { $lte: twoDaysAgo },
    });

    let confirmed = 0;
    for (const order of orders) {
      order.status = "delivered";
      order.deliveredAt = new Date();
      order.statusHistory.push({
        status: "delivered",
        timestamp: new Date(),
        note: "Auto-confirmed after 48 hours",
        updatedBy: new mongoose.Types.ObjectId("000000000000000000000000"), // System
      });

      if (order.paymentMethod === "cod") {
        order.paymentStatus = "completed";
        order.paidAt = new Date();
      }

      await order.save();
      confirmed++;
    }

    res.json({ message: `Auto-confirmed ${confirmed} orders`, count: confirmed });
  } catch (error: any) {
    console.error("Auto confirm deliveries error:", error);
    res.status(500).json({ message: "Failed to auto-confirm", error: error.message });
  }
};
