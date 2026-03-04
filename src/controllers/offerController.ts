import { Request, Response } from "express";
import { Types } from "mongoose";
import Offer from "../models/Offer.js";
import OfferApplication from "../models/OfferApplication.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { sendPushNotificationToUser, sendPushNotificationToUsers } from "../utils/pushNotifications.js";
import { processImage } from "../utils/ProcessImage.js";

const EXCLUDED_ORDER_STATUSES = ["cancelled", "refunded"];

type EligibilityResult = {
  eligible: boolean;
  totalSpent: number;
  requiredAmount: number;
  matchingOrders: number;
  month: number;
  year: number;
  orders: Array<{
    _id: string;
    orderNumber: string;
    totalAmount: number;
    status: string;
    createdAt: Date;
  }>;
};

const monthName = (month: number) => {
  const d = new Date(2000, month - 1, 1);
  return d.toLocaleString("en-IN", { month: "long" });
};

const getMonthRange = (month: number, year: number) => {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
};

const toObjectId = (value: string) => new Types.ObjectId(value);

const computeEligibility = async (
  userId: Types.ObjectId,
  offer: {
    minPurchaseAmount: number;
    eligibilityMonth: number;
    eligibilityYear: number;
  },
  includeOrders: boolean
): Promise<EligibilityResult> => {
  const { start, end } = getMonthRange(offer.eligibilityMonth, offer.eligibilityYear);

  const [summary] = await Order.aggregate([
    {
      $match: {
        buyer: userId,
        createdAt: { $gte: start, $lte: end },
        status: { $nin: EXCLUDED_ORDER_STATUSES },
      },
    },
    {
      $group: {
        _id: null,
        totalSpent: { $sum: "$totalAmount" },
        matchingOrders: { $sum: 1 },
      },
    },
  ]);

  const totalSpent = Number(summary?.totalSpent || 0);
  const matchingOrders = Number(summary?.matchingOrders || 0);
  const eligible = totalSpent >= Number(offer.minPurchaseAmount || 0);

  const orders = includeOrders
    ? (
        await Order.find({
          buyer: userId,
          createdAt: { $gte: start, $lte: end },
          status: { $nin: EXCLUDED_ORDER_STATUSES },
        })
          .select("_id orderNumber totalAmount status createdAt")
          .sort({ createdAt: -1 })
          .limit(30)
          .lean()
      ).map((order: any) => ({
        _id: String(order._id),
        orderNumber: String(order.orderNumber || ""),
        totalAmount: Number(order.totalAmount || 0),
        status: String(order.status || ""),
        createdAt: order.createdAt,
      }))
    : [];

  return {
    eligible,
    totalSpent,
    requiredAmount: Number(offer.minPurchaseAmount || 0),
    matchingOrders,
    month: offer.eligibilityMonth,
    year: offer.eligibilityYear,
    orders,
  };
};

const getSafeUserName = (user: any) => {
  const name = String(user?.name || "").trim();
  if (name) return name;
  const username = String(user?.username || "").trim();
  return username || "User";
};

const isValidDate = (value: any) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
};

const parseBooleanLike = (value: unknown, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
};

const parseOfferInput = (body: any) => {
  const title = String(body?.title || "").trim();
  const subtitle = String(body?.subtitle || "").trim();
  const message = String(body?.message || "").trim();
  const bannerImageUrl = String(body?.bannerImageUrl || "").trim();
  const brandLabel = String(body?.brandLabel || "Heeszo").trim() || "Heeszo";
  const ctaLabel = String(body?.ctaLabel || "Participate").trim() || "Participate";

  const minPurchaseAmount = Number(body?.minPurchaseAmount);
  const eligibilityMonth = Number(body?.eligibilityMonth);
  const eligibilityYear = Number(body?.eligibilityYear);
  const startDate = body?.startDate;
  const endDate = body?.endDate;
  const priority = Number(body?.priority);
  const isActive = parseBooleanLike(body?.isActive, true);

  return {
    title,
    subtitle: subtitle || undefined,
    message,
    bannerImageUrl: bannerImageUrl || undefined,
    brandLabel,
    ctaLabel,
    minPurchaseAmount,
    eligibilityMonth,
    eligibilityYear,
    startDate,
    endDate,
    priority: Number.isFinite(priority) && priority > 0 ? Math.round(priority) : 999,
    isActive,
  };
};

export const getActiveOffers = async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const offers = await Offer.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    })
      .select(
        "_id title subtitle message bannerImageUrl brandLabel ctaLabel minPurchaseAmount eligibilityMonth eligibilityYear startDate endDate priority"
      )
      .sort({ priority: 1, createdAt: -1 })
      .lean();

    res.status(200).json({ offers });
  } catch (error: any) {
    console.error("Get active offers error:", error);
    res.status(500).json({ message: "Failed to fetch active offers" });
  }
};

export const getOfferById = async (req: Request, res: Response) => {
  try {
    const { offerId } = req.params;
    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const offer = await Offer.findById(offerId).lean();
    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    res.status(200).json({ offer });
  } catch (error: any) {
    console.error("Get offer details error:", error);
    res.status(500).json({ message: "Failed to fetch offer details" });
  }
};

export const getOfferEligibility = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { offerId } = req.params;
    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const offer = await Offer.findById(offerId).lean();
    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    const [eligibility, existingApplication] = await Promise.all([
      computeEligibility(req.user._id, offer, true),
      OfferApplication.findOne({ offer: offer._id, user: req.user._id })
        .select("_id status createdAt reviewedAt")
        .lean(),
    ]);

    res.status(200).json({
      offer: {
        _id: offer._id,
        title: offer.title,
        subtitle: offer.subtitle,
        message: offer.message,
        brandLabel: offer.brandLabel,
        ctaLabel: offer.ctaLabel,
        minPurchaseAmount: offer.minPurchaseAmount,
        eligibilityMonth: offer.eligibilityMonth,
        eligibilityYear: offer.eligibilityYear,
        startDate: offer.startDate,
        endDate: offer.endDate,
      },
      eligibility: {
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
        requiredAmount: eligibility.requiredAmount,
        shortfall: Math.max(0, eligibility.requiredAmount - eligibility.totalSpent),
        matchingOrders: eligibility.matchingOrders,
        month: eligibility.month,
        year: eligibility.year,
        orders: eligibility.orders,
      },
      application: existingApplication || null,
    });
  } catch (error: any) {
    console.error("Get offer eligibility error:", error);
    res.status(500).json({ message: "Failed to evaluate eligibility" });
  }
};

export const applyForOffer = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { offerId } = req.params;
    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    const now = new Date();
    if (!offer.isActive || offer.startDate > now || offer.endDate < now) {
      return res.status(400).json({ message: "Offer is not active right now" });
    }

    const existing = await OfferApplication.findOne({
      offer: offer._id,
      user: req.user._id,
    });
    if (existing) {
      return res.status(409).json({
        message: "You already submitted an application for this offer",
        application: existing,
      });
    }

    const sourceUser = await User.findById(req.user._id).select("name username phone").lean();
    const fallbackName = getSafeUserName(sourceUser);
    const name = String(req.body?.name || fallbackName).trim() || fallbackName;
    const phone = String(req.body?.phone || sourceUser?.phone || "").trim();
    const note = String(req.body?.note || "").trim();

    const eligibility = await computeEligibility(req.user._id, offer, false);

    const application = await OfferApplication.create({
      offer: offer._id,
      user: req.user._id,
      name,
      phone: phone || undefined,
      note: note || undefined,
      status: "pending",
      eligibilitySnapshot: {
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
        requiredAmount: eligibility.requiredAmount,
        matchingOrders: eligibility.matchingOrders,
        month: eligibility.month,
        year: eligibility.year,
        lastCheckedAt: new Date(),
      },
    });

    const admins = await User.find({
      userType: "admin",
      isDeleted: { $ne: true },
    })
      .select("_id")
      .lean();

    if (admins.length > 0) {
      const adminNotificationMessage = `${name} applied for "${offer.title}" (${monthName(
        offer.eligibilityMonth
      )} ${offer.eligibilityYear})`;
      const adminIds = admins.map((admin: any) => String(admin._id));

      await Notification.insertMany(
        admins.map((admin: any) => ({
          recipient: admin._id,
          sender: req.user?._id,
          type: "system",
          title: "New offer application",
          message: adminNotificationMessage,
          metadata: {
            action: "offer_application_review",
            offerId: String(offer._id),
            applicationId: String(application._id),
            userId: String(req.user?._id),
            eligible: eligibility.eligible,
            totalSpent: eligibility.totalSpent,
          },
        }))
      );

      sendPushNotificationToUsers(adminIds, {
        title: "New offer application",
        body: adminNotificationMessage,
        data: {
          type: "offer_application",
          offerId: String(offer._id),
          applicationId: String(application._id),
          userId: String(req.user?._id),
        },
      }).catch((pushErr) => console.error("Offer application admin push error:", pushErr));
    }

    res.status(201).json({
      message: "Offer application submitted",
      application,
      eligibility: {
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
        requiredAmount: eligibility.requiredAmount,
        shortfall: Math.max(0, eligibility.requiredAmount - eligibility.totalSpent),
        matchingOrders: eligibility.matchingOrders,
        month: eligibility.month,
        year: eligibility.year,
      },
    });
  } catch (error: any) {
    console.error("Apply for offer error:", error);
    res.status(500).json({ message: "Failed to submit offer application" });
  }
};

export const getMyOfferApplications = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const applications = await OfferApplication.find({ user: req.user._id })
      .populate(
        "offer",
        "title subtitle message bannerImageUrl brandLabel ctaLabel minPurchaseAmount eligibilityMonth eligibilityYear startDate endDate isActive"
      )
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ applications });
  } catch (error: any) {
    console.error("Get my offer applications error:", error);
    res.status(500).json({ message: "Failed to fetch applications" });
  }
};

export const adminListOffers = async (req: AuthRequest, res: Response) => {
  try {
    const { status = "all" } = req.query;
    const now = new Date();
    const match: any = {};

    if (status === "active") match.isActive = true;
    if (status === "inactive") match.isActive = false;
    if (status === "running") {
      match.isActive = true;
      match.startDate = { $lte: now };
      match.endDate = { $gte: now };
    }

    const offers = await Offer.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "offerapplications",
          localField: "_id",
          foreignField: "offer",
          as: "applications",
        },
      },
      {
        $addFields: {
          applicationCount: { $size: "$applications" },
          pendingApplications: {
            $size: {
              $filter: {
                input: "$applications",
                as: "app",
                cond: { $eq: ["$$app.status", "pending"] },
              },
            },
          },
          approvedApplications: {
            $size: {
              $filter: {
                input: "$applications",
                as: "app",
                cond: { $eq: ["$$app.status", "approved"] },
              },
            },
          },
          rejectedApplications: {
            $size: {
              $filter: {
                input: "$applications",
                as: "app",
                cond: { $eq: ["$$app.status", "rejected"] },
              },
            },
          },
          isRunning: {
            $and: [
              "$isActive",
              { $lte: ["$startDate", now] },
              { $gte: ["$endDate", now] },
            ],
          },
        },
      },
      { $project: { applications: 0 } },
      { $sort: { priority: 1, createdAt: -1 } },
    ]);

    res.status(200).json({ offers });
  } catch (error: any) {
    console.error("Admin list offers error:", error);
    res.status(500).json({ message: "Failed to fetch offers" });
  }
};

export const adminCreateOffer = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const payload = parseOfferInput(req.body);
    const uploadFile = (req as any)?.file as Express.Multer.File | undefined;

    if (!payload.title || !payload.message) {
      return res.status(400).json({ message: "Title and message are required" });
    }
    if (!Number.isFinite(payload.minPurchaseAmount) || payload.minPurchaseAmount < 0) {
      return res.status(400).json({ message: "Minimum purchase amount must be 0 or greater" });
    }
    if (
      !Number.isInteger(payload.eligibilityMonth) ||
      payload.eligibilityMonth < 1 ||
      payload.eligibilityMonth > 12
    ) {
      return res.status(400).json({ message: "Eligibility month must be between 1 and 12" });
    }
    if (
      !Number.isInteger(payload.eligibilityYear) ||
      payload.eligibilityYear < 2020 ||
      payload.eligibilityYear > 2100
    ) {
      return res.status(400).json({ message: "Eligibility year is invalid" });
    }
    if (!isValidDate(payload.startDate) || !isValidDate(payload.endDate)) {
      return res.status(400).json({ message: "Start and end dates are required" });
    }

    const startDate = new Date(payload.startDate);
    const endDate = new Date(payload.endDate);
    if (endDate < startDate) {
      return res.status(400).json({ message: "End date must be after start date" });
    }

    let resolvedBannerImageUrl = payload.bannerImageUrl;
    if (uploadFile?.buffer) {
      const name = `offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const processed = await processImage(uploadFile.buffer, name);
      resolvedBannerImageUrl = processed.high;
    }

    const offer = await Offer.create({
      ...payload,
      bannerImageUrl: resolvedBannerImageUrl,
      startDate,
      endDate,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    res.status(201).json({ message: "Offer created successfully", offer });
  } catch (error: any) {
    console.error("Admin create offer error:", error);
    res.status(500).json({ message: "Failed to create offer" });
  }
};

export const adminUpdateOffer = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { offerId } = req.params;
    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const existing = await Offer.findById(offerId);
    if (!existing) {
      return res.status(404).json({ message: "Offer not found" });
    }

    const payload = parseOfferInput(req.body);
    const uploadFile = (req as any)?.file as Express.Multer.File | undefined;
    const updates: any = { updatedBy: req.user._id };

    if (req.body?.title !== undefined) {
      if (!payload.title) return res.status(400).json({ message: "Title cannot be empty" });
      updates.title = payload.title;
    }
    if (req.body?.subtitle !== undefined) updates.subtitle = payload.subtitle;
    if (req.body?.message !== undefined) {
      if (!payload.message) return res.status(400).json({ message: "Message cannot be empty" });
      updates.message = payload.message;
    }
    if (req.body?.bannerImageUrl !== undefined) updates.bannerImageUrl = payload.bannerImageUrl;
    if (req.body?.brandLabel !== undefined) updates.brandLabel = payload.brandLabel;
    if (req.body?.ctaLabel !== undefined) updates.ctaLabel = payload.ctaLabel;
    if (req.body?.priority !== undefined) updates.priority = payload.priority;
    if (req.body?.isActive !== undefined) updates.isActive = payload.isActive;

    if (req.body?.minPurchaseAmount !== undefined) {
      if (!Number.isFinite(payload.minPurchaseAmount) || payload.minPurchaseAmount < 0) {
        return res.status(400).json({ message: "Minimum purchase amount must be 0 or greater" });
      }
      updates.minPurchaseAmount = payload.minPurchaseAmount;
    }
    if (req.body?.eligibilityMonth !== undefined) {
      if (
        !Number.isInteger(payload.eligibilityMonth) ||
        payload.eligibilityMonth < 1 ||
        payload.eligibilityMonth > 12
      ) {
        return res.status(400).json({ message: "Eligibility month must be between 1 and 12" });
      }
      updates.eligibilityMonth = payload.eligibilityMonth;
    }
    if (req.body?.eligibilityYear !== undefined) {
      if (
        !Number.isInteger(payload.eligibilityYear) ||
        payload.eligibilityYear < 2020 ||
        payload.eligibilityYear > 2100
      ) {
        return res.status(400).json({ message: "Eligibility year is invalid" });
      }
      updates.eligibilityYear = payload.eligibilityYear;
    }

    if (req.body?.startDate !== undefined) {
      if (!isValidDate(payload.startDate)) return res.status(400).json({ message: "Invalid start date" });
      updates.startDate = new Date(payload.startDate);
    }
    if (req.body?.endDate !== undefined) {
      if (!isValidDate(payload.endDate)) return res.status(400).json({ message: "Invalid end date" });
      updates.endDate = new Date(payload.endDate);
    }

    if (uploadFile?.buffer) {
      const name = `offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const processed = await processImage(uploadFile.buffer, name);
      updates.bannerImageUrl = processed.high;
    }

    const nextStartDate = updates.startDate || existing.startDate;
    const nextEndDate = updates.endDate || existing.endDate;
    if (nextEndDate < nextStartDate) {
      return res.status(400).json({ message: "End date must be after start date" });
    }

    const offer = await Offer.findByIdAndUpdate(offerId, { $set: updates }, { new: true });
    res.status(200).json({ message: "Offer updated successfully", offer });
  } catch (error: any) {
    console.error("Admin update offer error:", error);
    res.status(500).json({ message: "Failed to update offer" });
  }
};

export const adminToggleOffer = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { offerId } = req.params;
    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    offer.isActive = !offer.isActive;
    offer.updatedBy = req.user._id;
    await offer.save();

    res.status(200).json({
      message: offer.isActive ? "Offer activated" : "Offer paused",
      offer,
    });
  } catch (error: any) {
    console.error("Admin toggle offer error:", error);
    res.status(500).json({ message: "Failed to toggle offer" });
  }
};

export const adminGetOfferApplications = async (req: AuthRequest, res: Response) => {
  try {
    const { offerId } = req.params;
    const { status = "all" } = req.query;

    if (!Types.ObjectId.isValid(offerId)) {
      return res.status(400).json({ message: "Invalid offer id" });
    }

    const offer = await Offer.findById(offerId)
      .select(
        "_id title subtitle message minPurchaseAmount eligibilityMonth eligibilityYear startDate endDate isActive priority"
      )
      .lean();
    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }

    const query: any = { offer: offer._id };
    if (status !== "all") {
      query.status = status;
    }

    const applications = await OfferApplication.find(query)
      .populate("user", "name username email profilePic")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ offer, applications });
  } catch (error: any) {
    console.error("Admin get offer applications error:", error);
    res.status(500).json({ message: "Failed to fetch offer applications" });
  }
};

export const adminRefreshOfferApplicationEligibility = async (req: AuthRequest, res: Response) => {
  try {
    const { offerId, applicationId } = req.params;
    if (!Types.ObjectId.isValid(offerId) || !Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid offer/application id" });
    }

    const [offer, application] = await Promise.all([
      Offer.findById(offerId),
      OfferApplication.findOne({ _id: applicationId, offer: toObjectId(offerId) }),
    ]);

    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const eligibility = await computeEligibility(application.user as Types.ObjectId, offer, true);

    application.eligibilitySnapshot = {
      eligible: eligibility.eligible,
      totalSpent: eligibility.totalSpent,
      requiredAmount: eligibility.requiredAmount,
      matchingOrders: eligibility.matchingOrders,
      month: eligibility.month,
      year: eligibility.year,
      lastCheckedAt: new Date(),
    };
    await application.save();

    res.status(200).json({
      application,
      eligibility: {
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
        requiredAmount: eligibility.requiredAmount,
        shortfall: Math.max(0, eligibility.requiredAmount - eligibility.totalSpent),
        matchingOrders: eligibility.matchingOrders,
        month: eligibility.month,
        year: eligibility.year,
        orders: eligibility.orders,
      },
    });
  } catch (error: any) {
    console.error("Refresh offer application eligibility error:", error);
    res.status(500).json({ message: "Failed to refresh eligibility" });
  }
};

export const adminReviewOfferApplication = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { offerId, applicationId } = req.params;
    const status = String(req.body?.status || "").trim();
    const adminMessage = String(req.body?.adminMessage || "").trim();

    if (!Types.ObjectId.isValid(offerId) || !Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid offer/application id" });
    }
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Status must be approved or rejected" });
    }

    const [offer, application] = await Promise.all([
      Offer.findById(offerId),
      OfferApplication.findOne({ _id: applicationId, offer: toObjectId(offerId) }),
    ]);

    if (!offer) {
      return res.status(404).json({ message: "Offer not found" });
    }
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const eligibility = await computeEligibility(application.user as Types.ObjectId, offer, false);
    if (status === "approved" && !eligibility.eligible) {
      return res.status(400).json({
        message: "User is not eligible for approval based on monthly purchases",
        eligibility: {
          eligible: false,
          totalSpent: eligibility.totalSpent,
          requiredAmount: eligibility.requiredAmount,
          shortfall: Math.max(0, eligibility.requiredAmount - eligibility.totalSpent),
        },
      });
    }

    application.status = status as "approved" | "rejected";
    application.adminMessage = adminMessage || undefined;
    application.reviewedBy = req.user._id;
    application.reviewedAt = new Date();
    application.eligibilitySnapshot = {
      eligible: eligibility.eligible,
      totalSpent: eligibility.totalSpent,
      requiredAmount: eligibility.requiredAmount,
      matchingOrders: eligibility.matchingOrders,
      month: eligibility.month,
      year: eligibility.year,
      lastCheckedAt: new Date(),
    };
    await application.save();

    const approvalTitle =
      status === "approved" ? "Offer application approved" : "Offer application update";
    const defaultMessage =
      status === "approved"
        ? `Your application for "${offer.title}" is approved.`
        : `Your application for "${offer.title}" is currently not eligible for ${monthName(
            offer.eligibilityMonth
          )} ${offer.eligibilityYear}.`;
    const finalMessage = adminMessage ? `${defaultMessage} ${adminMessage}` : defaultMessage;

    await Notification.create({
      recipient: application.user,
      sender: req.user._id,
      type: "system",
      title: approvalTitle,
      message: finalMessage,
      metadata: {
        action: "offer_application_result",
        offerId: String(offer._id),
        applicationId: String(application._id),
        status,
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
      },
    });

    sendPushNotificationToUser(String(application.user), {
      title: approvalTitle,
      body: finalMessage,
      data: {
        type: "offer",
        offerId: String(offer._id),
        applicationId: String(application._id),
        status,
      },
    }).catch((pushErr) => console.error("Offer application decision push error:", pushErr));

    res.status(200).json({
      message: `Application ${status}`,
      application,
      eligibility: {
        eligible: eligibility.eligible,
        totalSpent: eligibility.totalSpent,
        requiredAmount: eligibility.requiredAmount,
        shortfall: Math.max(0, eligibility.requiredAmount - eligibility.totalSpent),
        matchingOrders: eligibility.matchingOrders,
      },
    });
  } catch (error: any) {
    console.error("Admin review offer application error:", error);
    res.status(500).json({ message: "Failed to review application" });
  }
};
