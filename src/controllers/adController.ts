import { Request, Response } from "express";
import Ad from "../models/Ad.js";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { processImage } from "../utils/ProcessImage.js";

/* ======================================================
   AD CONTROLLER: CRUD Operations for Advertisements
   - Admin: Create, Read, Update, Delete ads
   - Public: Track clicks/impressions
====================================================== */

/* =========================
   CREATE AD (Admin Only)
========================= */
export const createAd = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const {
      title,
      description,
      linkUrl,
      type,
      priority,
      startDate,
      endDate
    } = req.body;

    // Parse payment and advertiser - they come as JSON strings from FormData
    let payment = req.body.payment;
    let advertiser = req.body.advertiser;
    
    if (typeof payment === 'string') {
      try { payment = JSON.parse(payment); } catch { payment = {}; }
    }
    if (typeof advertiser === 'string') {
      try { advertiser = JSON.parse(advertiser); } catch { advertiser = {}; }
    }

    // Validate required fields (linkUrl is optional)
    if (!title || !type || !startDate || !endDate || !advertiser?.name || !advertiser?.email) {
      return res.status(400).json({ 
        message: "Missing required fields",
        details: {
          title: !title ? "missing" : "ok",
          type: !type ? "missing" : "ok",
          startDate: !startDate ? "missing" : "ok",
          endDate: !endDate ? "missing" : "ok",
          advertiserName: !advertiser?.name ? "missing" : "ok",
          advertiserEmail: !advertiser?.email ? "missing" : "ok"
        }
      });
    }

    // Handle image upload
    let imageUrl = req.body.imageUrl;
    if (req.file) {
      const name = `ad-${Date.now()}-${Math.random()}`;
      const processed = await processImage(req.file.buffer, name);
      imageUrl = processed.high; // Use high quality for ads
    }

    if (!imageUrl) {
      return res.status(400).json({ message: "Ad image is required" });
    }

    const ad = await Ad.create({
      title,
      description,
      imageUrl,
      linkUrl,
      type,
      priority: Number.isFinite(Number(priority)) ? Math.max(1, Number(priority)) : 999,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      payment: {
        amount: payment?.amount || 0,
        currency: payment?.currency || "INR",
        method: payment?.method || "manual",
        status: payment?.status || "pending",
        transactionId: payment?.transactionId
      },
      advertiser: {
        name: advertiser.name,
        email: advertiser.email,
        company: advertiser.company,
        phone: advertiser.phone
      },
      isActive: true
    });

    res.status(201).json({
      message: "Ad created successfully",
      ad
    });

  } catch (err: any) {
    console.error("Create Ad Error:", err);
    res.status(500).json({ message: "Failed to create ad" });
  }
};

/* =========================
   GET ALL ADS (Admin)
========================= */
export const getAllAds = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { type, status, active } = req.query;
    const query: any = {};

    if (type) query.type = type;
    if (status) query["payment.status"] = status;
    if (active === "true") {
      const now = new Date();
      query.isActive = true;
      query.startDate = { $lte: now };
      query.endDate = { $gte: now };
    }

    const ads = await Ad.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Calculate stats
    const now = new Date();
    const stats = {
      total: ads.length,
      active: ads.filter(a => a.isActive && new Date(a.startDate) <= now && new Date(a.endDate) >= now).length,
      inFeed: ads.filter(a => a.type === "in-feed").length,
      banner: ads.filter(a => a.type === "banner").length,
      totalImpressions: ads.reduce((sum, a) => sum + a.impressions, 0),
      totalClicks: ads.reduce((sum, a) => sum + a.clicks, 0),
      totalRevenue: ads.filter(a => a.payment.status === "paid").reduce((sum, a) => sum + a.payment.amount, 0)
    };

    res.json({ ads, stats });

  } catch (err) {
    console.error("Get All Ads Error:", err);
    res.status(500).json({ message: "Failed to fetch ads" });
  }
};

/* =========================
   GET SINGLE AD
========================= */
export const getAdById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ad = await Ad.findById(id).lean();

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    res.json(ad);
  } catch (err) {
    console.error("Get Ad Error:", err);
    res.status(500).json({ message: "Failed to fetch ad" });
  }
};

/* =========================
   UPDATE AD (Admin Only)
========================= */
export const updateAd = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { id } = req.params;
    const updates = { ...req.body };

    // Parse payment and advertiser - they come as JSON strings from FormData
    if (typeof updates.payment === 'string') {
      try { updates.payment = JSON.parse(updates.payment); } catch { /* keep as is */ }
    }
    if (typeof updates.advertiser === 'string') {
      try { updates.advertiser = JSON.parse(updates.advertiser); } catch { /* keep as is */ }
    }

    // Handle image upload if provided
    if (req.file) {
      const name = `ad-${Date.now()}-${Math.random()}`;
      const processed = await processImage(req.file.buffer, name);
      updates.imageUrl = processed.high;
    }

    // Parse dates if provided
    if (updates.startDate) updates.startDate = new Date(updates.startDate);
    if (updates.endDate) updates.endDate = new Date(updates.endDate);
    if (updates.priority !== undefined) {
      const parsedPriority = Number(updates.priority);
      updates.priority = Number.isFinite(parsedPriority) ? Math.max(1, parsedPriority) : 999;
    }

    const ad = await Ad.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    res.json({
      message: "Ad updated successfully",
      ad
    });

  } catch (err) {
    console.error("Update Ad Error:", err);
    res.status(500).json({ message: "Failed to update ad" });
  }
};

/* =========================
   DELETE AD (Admin Only)
========================= */
export const deleteAd = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { id } = req.params;
    const ad = await Ad.findByIdAndDelete(id);

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    res.json({ message: "Ad deleted successfully", id });

  } catch (err) {
    console.error("Delete Ad Error:", err);
    res.status(500).json({ message: "Failed to delete ad" });
  }
};

/* =========================
   TOGGLE AD STATUS (Admin)
========================= */
export const toggleAdStatus = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { id } = req.params;
    const ad = await Ad.findById(id);

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    ad.isActive = !ad.isActive;
    await ad.save();

    res.json({
      message: `Ad ${ad.isActive ? "activated" : "deactivated"}`,
      ad
    });

  } catch (err) {
    console.error("Toggle Ad Status Error:", err);
    res.status(500).json({ message: "Failed to toggle ad status" });
  }
};

/* =========================
   UPDATE PAYMENT STATUS (Admin)
========================= */
export const updatePaymentStatus = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { id } = req.params;
    const { status, transactionId } = req.body;

    if (!["pending", "paid", "refunded"].includes(status)) {
      return res.status(400).json({ message: "Invalid payment status" });
    }

    const ad = await Ad.findByIdAndUpdate(
      id,
      { 
        "payment.status": status,
        ...(transactionId && { "payment.transactionId": transactionId })
      },
      { new: true }
    );

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    res.json({
      message: "Payment status updated",
      ad
    });

  } catch (err) {
    console.error("Update Payment Error:", err);
    res.status(500).json({ message: "Failed to update payment" });
  }
};

/* =========================
   TRACK AD CLICK (Public)
   - Called when user clicks an ad
========================= */
export const trackAdClick = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const ad = await Ad.findByIdAndUpdate(
      id,
      { $inc: { clicks: 1 } },
      { new: true }
    );

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    // Return the link URL for redirect
    res.json({ 
      success: true,
      linkUrl: ad.linkUrl 
    });

  } catch (err) {
    console.error("Track Click Error:", err);
    res.status(500).json({ message: "Failed to track click" });
  }
};

/* =========================
   GET AD ANALYTICS (Admin)
========================= */
export const getAdAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user || req.user.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const now = new Date();

    const [totalAds, activeAds, aggregateStats, topAds, byType] = await Promise.all([
      Ad.countDocuments(),
      Ad.countDocuments({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
      }),
      // Aggregate stats
      Ad.aggregate([
        {
          $group: {
            _id: null,
            totalImpressions: { $sum: "$impressions" },
            totalClicks: { $sum: "$clicks" },
            totalRevenue: {
              $sum: {
                $cond: [{ $eq: ["$payment.status", "paid"] }, "$payment.amount", 0],
              },
            },
          },
        },
      ]),
      // Top performing ads
      Ad.find()
        .sort({ clicks: -1 })
        .limit(5)
        .select("title type impressions clicks payment.amount")
        .lean(),
      // Ads by type
      Ad.aggregate([
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
            impressions: { $sum: "$impressions" },
            clicks: { $sum: "$clicks" },
          },
        },
      ]),
    ]);

    res.json({
      overview: {
        totalAds,
        activeAds,
        totalImpressions: aggregateStats[0]?.totalImpressions || 0,
        totalClicks: aggregateStats[0]?.totalClicks || 0,
        totalRevenue: aggregateStats[0]?.totalRevenue || 0,
        averageCTR: aggregateStats[0]?.totalImpressions > 0 
          ? ((aggregateStats[0].totalClicks / aggregateStats[0].totalImpressions) * 100).toFixed(2)
          : 0
      },
      topAds,
      byType
    });

  } catch (err) {
    console.error("Ad Analytics Error:", err);
    res.status(500).json({ message: "Failed to fetch analytics" });
  }
};

/* =========================
   GET ACTIVE ADS FOR FRONTEND
   - Public endpoint for fetching displayable ads
========================= */
export const getActiveAds = async (req: Request, res: Response) => {
  try {
    const { type } = req.query;
    const now = new Date();

    const query: any = {
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
      "payment.status": "paid"
    };

    if (type) query.type = type;

    const ads = await Ad.find(query)
      .select("_id title description imageUrl linkUrl type priority")
      .sort({ priority: 1, createdAt: 1 })
      .lean();

    res.json(ads);
  } catch (err) {
    console.error("Get Active Ads Error:", err);
    res.status(500).json({ message: "Failed to fetch active ads" });
  }
};
