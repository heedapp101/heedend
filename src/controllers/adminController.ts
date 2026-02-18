import { Request, Response } from "express";
import User from "../models/User.js";
import ImagePost from "../models/ImagePost.js";
import RecommendationAnalytics from "../models/RecommendationAnalytics.js";
import Report from "../models/Report.js";
import UserReport from "../models/UserReport.js";
import crypto from "crypto";
const signPrivateUrl = (url: string) => {
  // Only sign if it's a private URL
  if (!url || !url.includes("/private/")) return url;

  try {
    // Extract the 'key' (path after the domain)
    // Example: https://pub-xxx.r2.dev/private/123-doc.pdf -> private/123-doc.pdf
    const urlObj = new URL(url);
    const key = urlObj.pathname.slice(1); // Remove leading slash

    const expiry = Date.now() + 60 * 60 * 1000; // Link valid for 1 hour
    const dataToSign = `${key}-${expiry}`;

    const signature = crypto
      .createHmac("sha256", process.env.ADMIN_SECRET!)
      .update(dataToSign)
      .digest("hex");

    return `${url}?sig=${signature}&exp=${expiry}`;
  } catch (e) {
    return url; // Fallback if URL parsing fails
  }
};
export const getPendingApprovals = async (req: Request, res: Response) => {
  try {
    const pendingUsers = await User.find({ 
      userType: "business", 
      isVerified: false 
    }).select("-password").lean(); // ✅ Use .lean() to allow modifying the JSON
    
    // ✅ Attach Signature to ID Documents
    const signedUsers = pendingUsers.map((user: any) => ({
      ...user,
      idProofUrl: user.idProofUrl ? signPrivateUrl(user.idProofUrl) : user.idProofUrl
    }));
    
    res.status(200).json(signedUsers);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};
export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const { role, search, sortBy, order, includeDeleted } = req.query;

    // 1. Match Stage (Filtering)
    const matchStage: any = {};
    
    if (includeDeleted !== "true") {
      matchStage.isDeleted = { $ne: true };
    }

    if (role && role !== "all") {
      matchStage.userType = role;
    }

    if (search) {
      matchStage.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
      ];
    }

    // 2. Sort Logic
    // Default to 'createdAt' descending (newest first)
    const sortField = (sortBy as string) || "createdAt";
    const sortOrder = order === "asc" ? 1 : -1;

    const users = await User.aggregate([
      { $match: matchStage },
      // Join Posts
      {
        $lookup: {
          from: "imageposts",
          localField: "_id",
          foreignField: "user",
          as: "posts",
        },
      },
      // Calculate Fields
      {
        $project: {
          _id: 1,
          name: 1,
          username: 1,
          email: 1,
          phone: 1,
          bio: 1,
          userType: 1,
          profilePic: 1,
          isVerified: 1,
          isDeleted: 1,
          deletedAt: 1,
          deletedBy: 1,
          createdAt: 1,
          interests: 1,
          location: 1,
          // Business-specific fields
          companyName: 1,
          country: 1,
          address: 1,
          gstNumber: 1,
          idProofType: 1,
          idProofNumber: 1,
          idProofUrl: 1,
          productType: 1,
          cashOnDeliveryAvailable: 1,
          allIndiaDelivery: 1,
          freeShipping: 1,
          returnPolicy: 1,
          requireChatBeforePurchase: 1,
          autoReplyEnabled: 1,
          autoReplyMessage: 1,
          customQuickQuestion: 1,
          inventoryAlertThreshold: 1,
          paymentDetails: 1,
          // General-specific fields
          age: 1,
          gender: 1,
          postCount: { $size: "$posts" },
          // Score Calculation
          couponScore: {
            $add: [
              { $multiply: [{ $size: "$posts" }, 10] },
              { $multiply: [{ $size: { $ifNull: ["$interests", []] } }, 5] },
              { $floor: { $multiply: [{ $rand: {} }, 50] } } 
            ]
          }
        },
      },
      // 3. Dynamic Sort Stage
      { $sort: { [sortField]: sortOrder } },
    ]);

    // Sign private ID proof URLs for business users
    const signedUsers = users.map((user: any) => ({
      ...user,
      idProofUrl: user.idProofUrl ? signPrivateUrl(user.idProofUrl) : user.idProofUrl,
    }));

    res.status(200).json(signedUsers);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const getDeletedUsers = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const match: any = { isDeleted: true };
    if (search) {
      match.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
      ];
    }

    const users = await User.find(match)
      .select("name username email userType deletedAt deletedBy deletedReason createdAt")
      .sort({ deletedAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    const total = await User.countDocuments(match);

    res.status(200).json({
      users,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   ✅ NEW: DASHBOARD STATS
======================= */
export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    // 1. Quick Stats
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      totalUsers,
      deletedUsers,
      businessUsers,
      pendingApprovals,
      totalPosts,
      userGrowth,
      recentUsers,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isDeleted: true }),
      User.countDocuments({ userType: "business" }),
      User.countDocuments({ userType: "business", isVerified: false }),
      ImagePost.countDocuments(),
      // 2. Graph Data: User Growth (Last 7 Days)
      User.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            users: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // 3. Recent Activity (Newest 5 Users)
      User.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select("username email userType createdAt")
        .lean(),
    ]);

    res.status(200).json({
      stats: {
        totalUsers,
        deletedUsers,
        businessUsers,
        pendingApprovals,
        totalPosts,
      },
      graphData: userGrowth.map(d => ({ date: d._id, users: d.users })),
      recentUsers,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// APPROVE USER
export const approveUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await User.findByIdAndUpdate(id, { isVerified: true });
    res.status(200).json({ message: "User Approved ✅" });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// REJECT USER (DELETE)
export const rejectUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await User.findByIdAndDelete(id);
    res.status(200).json({ message: "User Rejected ❌" });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   RECOMMENDATION ANALYTICS
   - CTR (Click-Through Rate)
   - Dwell Time
   - Like Rate
   - Return Rate
======================= */
export const getRecommendationAnalytics = async (req: Request, res: Response) => {
  try {
    const timeRange = parseInt(req.query.days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - timeRange);

    // 1. CTR (Click-Through Rate) - % of recommended posts that were viewed
    const totalRecommendations = await RecommendationAnalytics.countDocuments({
      source: "recommended",
      clickedAt: { $gte: startDate },
    });

    const viewedRecommendations = await RecommendationAnalytics.countDocuments({
      source: "recommended",
      action: "view",
      clickedAt: { $gte: startDate },
    });

    const ctr = totalRecommendations > 0 
      ? ((viewedRecommendations / totalRecommendations) * 100).toFixed(2)
      : 0;

    // 2. Average Dwell Time - How long users stay on recommended posts
    const dwellTimeData = await RecommendationAnalytics.aggregate([
      {
        $match: {
          source: "recommended",
          action: "view",
          dwellTime: { $gt: 0 },
          clickedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: null,
          avgDwellTime: { $avg: "$dwellTime" },
          totalViews: { $sum: 1 },
        },
      },
    ]);

    const avgDwellTime = dwellTimeData.length > 0 
      ? Math.round(dwellTimeData[0].avgDwellTime) 
      : 0;

    // 3. Like Rate - % of viewed recommended posts that get liked
    const likedRecommendations = await RecommendationAnalytics.countDocuments({
      source: "recommended",
      action: "like",
      clickedAt: { $gte: startDate },
    });

    const likeRate = viewedRecommendations > 0
      ? ((likedRecommendations / viewedRecommendations) * 100).toFixed(2)
      : 0;

    // 4. Return Rate - Users who came back in the last 24 hours
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const activeUsersTotal = await User.countDocuments();
    const returningUsers = await RecommendationAnalytics.distinct("userId", {
      clickedAt: { $gte: oneDayAgo },
    });

    const returnRate = activeUsersTotal > 0
      ? ((returningUsers.length / activeUsersTotal) * 100).toFixed(2)
      : 0;

    // 5. Engagement by Source (breakdown)
    const engagementBySource = await RecommendationAnalytics.aggregate([
      { $match: { clickedAt: { $gte: startDate } } },
      {
        $group: {
          _id: "$source",
          views: {
            $sum: { $cond: [{ $eq: ["$action", "view"] }, 1, 0] },
          },
          likes: {
            $sum: { $cond: [{ $eq: ["$action", "like"] }, 1, 0] },
          },
          comments: {
            $sum: { $cond: [{ $eq: ["$action", "comment"] }, 1, 0] },
          },
        },
      },
      { $sort: { views: -1 } },
    ]);

    // 6. Daily Trend (Last 7 days)
    const dailyTrend = await RecommendationAnalytics.aggregate([
      { $match: { clickedAt: { $gte: startDate }, source: "recommended" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$clickedAt" } },
          views: {
            $sum: { $cond: [{ $eq: ["$action", "view"] }, 1, 0] },
          },
          likes: {
            $sum: { $cond: [{ $eq: ["$action", "like"] }, 1, 0] },
          },
          avgDwellTime: { $avg: "$dwellTime" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // 7. Top Performing Posts (from recommendations)
    const topPosts = await RecommendationAnalytics.aggregate([
      {
        $match: {
          source: "recommended",
          action: { $in: ["view", "like"] },
          clickedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: "$postId",
          views: {
            $sum: { $cond: [{ $eq: ["$action", "view"] }, 1, 0] },
          },
          likes: {
            $sum: { $cond: [{ $eq: ["$action", "like"] }, 1, 0] },
          },
          engagementScore: {
            $sum: {
              $cond: [
                { $eq: ["$action", "like"] },
                3,
                { $cond: [{ $eq: ["$action", "view"] }, 1, 0] },
              ],
            },
          },
        },
      },
      { $sort: { engagementScore: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "imageposts",
          localField: "_id",
          foreignField: "_id",
          as: "post",
        },
      },
      { $unwind: "$post" },
      {
        $project: {
          _id: 1,
          views: 1,
          likes: 1,
          engagementScore: 1,
          "post.title": 1,
          "post.images": 1,
        },
      },
    ]);

    res.status(200).json({
      summary: {
        ctr: parseFloat(ctr as string),
        avgDwellTime,
        likeRate: parseFloat(likeRate as string),
        returnRate: parseFloat(returnRate as string),
        totalRecommendations,
        viewedRecommendations,
        likedRecommendations,
        activeUsers: returningUsers.length,
      },
      engagementBySource,
      dailyTrend: dailyTrend.map((d) => ({
        date: d._id,
        views: d.views,
        likes: d.likes,
        avgDwellTime: Math.round(d.avgDwellTime || 0),
      })),
      topPosts,
    });
  } catch (error: any) {
    console.error("Recommendation Analytics Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   UPDATE DWELL TIME
   (Called from frontend when user leaves a post)
======================= */
export const updateDwellTime = async (req: Request, res: Response) => {
  try {
    const { postId, dwellTime } = req.body;
    
    if (!postId || !dwellTime) {
      return res.status(400).json({ message: "Missing postId or dwellTime" });
    }

    // Find the most recent view record for this user and post
    await RecommendationAnalytics.findOneAndUpdate(
      {
        userId: (req as any).user._id,
        postId,
        action: "view",
      },
      { dwellTime },
      { sort: { clickedAt: -1 } }
    );

    res.status(200).json({ message: "Dwell time updated" });
  } catch (error: any) {
    console.error("Update Dwell Time Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   AWARD / PROMOTION ADMIN
   - Rank posts by engagement
   - Mark as awarded/paid
   - Hide/unhide from promo section
======================= */
export const getAwardCandidates = async (req: Request, res: Response) => {
  try {
    const days = Math.max(parseInt(req.query.days as string) || 30, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const tag = req.query.tag as string | undefined;
    const includeAwarded = req.query.includeAwarded === "true";
    const includeHidden = req.query.includeHidden === "true";

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const match: any = { createdAt: { $gte: startDate } };
    if (tag) {
      match.tags = { $regex: new RegExp(tag, "i") };
    }
    if (!includeAwarded) {
      match.isAwarded = { $ne: true };
    }
    if (!includeHidden) {
      match.$and = match.$and || [];
      match.$and.push({ $or: [{ adminHidden: false }, { adminHidden: { $exists: false } }] });
      match.$and.push({ $or: [{ isArchived: false }, { isArchived: { $exists: false } }] });
    }

    const candidates = await ImagePost.aggregate([
      { $match: match },
      {
        $addFields: {
          likesCount: { $ifNull: ["$likesCount", 0] },
          engagementScore: {
            $add: [
              { $ifNull: ["$views", 0] },
              { $multiply: [{ $ifNull: ["$likesCount", 0] }, 3] },
            ],
          },
        },
      },
      { $sort: { engagementScore: -1, createdAt: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 1,
          title: 1,
          images: 1,
          tags: 1,
          views: 1,
          likesCount: 1,
          createdAt: 1,
          engagementScore: 1,
          "user._id": 1,
          "user.username": 1,
          "user.userType": 1,
          "user.profilePic": 1,
        },
      },
    ]);

    res.status(200).json({
      windowDays: days,
      total: candidates.length,
      candidates,
    });
  } catch (error: any) {
    console.error("Get Award Candidates Error:", error);
    res.status(500).json({ message: error.message });
  }
};

export const updateAwardStatus = async (req: Request, res: Response) => {
  try {
    const { postId } = req.params as { postId: string };
    const { isAwarded, status, amount, hidden, priority, adminHidden } = req.body as {
      isAwarded?: boolean;
      status?: string;
      amount?: number | string;
      hidden?: boolean;
      priority?: number;
      adminHidden?: boolean;
    };

    const validStatuses = ["pending", "approved", "paid", "rejected"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid award status" });
    }

    const update: any = {};

    if (typeof adminHidden === "boolean") {
      update.adminHidden = adminHidden;
    }

    if (typeof hidden === "boolean") {
      update.awardHidden = hidden;
    }

    if (typeof priority === "number" && Number.isFinite(priority)) {
      update.awardPriority = Math.floor(priority);
    }

    if (amount !== undefined) {
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ message: "awardAmount must be 0 or greater" });
      }
      update.awardAmount = parsed;
    }

    if (typeof isAwarded === "boolean") {
      update.isAwarded = isAwarded;
      if (isAwarded) {
        update.awardedAt = new Date();
        if (!status) {
          update.awardStatus = "paid"; // default for now
          update.awardPaidAt = new Date();
        }
      } else {
        update.awardStatus = "pending";
        update.awardedAt = undefined;
        update.awardPaidAt = undefined;
        update.awardAmount = undefined;
        update.awardHidden = false;
        update.awardPriority = 0;
      }
    }

    if (status) {
      update.awardStatus = status;
      if (status === "paid") {
        update.awardPaidAt = new Date();
        update.isAwarded = true;
        if (!update.awardedAt) update.awardedAt = new Date();
      }
    }

    const post = await ImagePost.findByIdAndUpdate(postId, update, { new: true });
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.status(200).json({ success: true, post });
  } catch (error: any) {
    console.error("Update Award Error:", error);
    res.status(500).json({ message: error.message });
  }
};

export const updatePostVisibility = async (req: Request, res: Response) => {
  try {
    const { postId } = req.params as { postId: string };
    const { hidden } = req.body as { hidden?: boolean };

    if (typeof hidden !== "boolean") {
      return res.status(400).json({ message: "hidden must be true or false" });
    }

    const post = await ImagePost.findByIdAndUpdate(
      postId,
      { adminHidden: hidden },
      { new: true }
    );

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.status(200).json({ success: true, post });
  } catch (error: any) {
    console.error("Update Post Visibility Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   GET REPORTED POSTS
======================= */
export const getReportedPosts = async (req: Request, res: Response) => {
  try {
    const { status = "pending", page = 1, limit = 20 } = req.query;
    
    const skip = (Number(page) - 1) * Number(limit);
    
    const reports = await Report.find({ status })
      .populate({
        path: "post",
        select: "title images user createdAt",
        populate: { path: "user", select: "username email profilePic userType" },
      })
      .populate("reporter", "username email")
      .populate("reviewedBy", "username")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();
    
    // Group reports by post
    const postReports = new Map<string, any>();
    
    for (const report of reports) {
      if (!report.post) continue;
      const postId = (report.post as any)._id.toString();
      
      if (!postReports.has(postId)) {
        postReports.set(postId, {
          post: report.post,
          reports: [],
          totalReports: 0,
        });
      }
      
      postReports.get(postId).reports.push({
        _id: report._id,
        reason: report.reason,
        customReason: report.customReason,
        reporter: report.reporter,
        createdAt: report.createdAt,
        status: report.status,
      });
      postReports.get(postId).totalReports += 1;
    }
    
    const total = await Report.countDocuments({ status });
    
    res.status(200).json({
      reports: Array.from(postReports.values()),
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (error: any) {
    console.error("Get Reported Posts Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   UPDATE REPORT STATUS
======================= */
export const updateReportStatus = async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const { status, adminNotes } = req.body;
    
    const validStatuses = ["reviewed", "dismissed", "action_taken"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    
    const report = await Report.findByIdAndUpdate(
      reportId,
      {
        status,
        adminNotes,
        reviewedBy: (req as any).user._id,
        reviewedAt: new Date(),
      },
      { new: true }
    );
    
    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }
    
    res.status(200).json({ success: true, report });
  } catch (error: any) {
    console.error("Update Report Status Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   DELETE REPORTED POST
======================= */
export const deleteReportedPost = async (req: Request, res: Response) => {
  try {
    const { postId } = req.params;
    
    // Delete the post
    const post = await ImagePost.findByIdAndDelete(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    
    // Update all reports for this post to "action_taken"
    await Report.updateMany(
      { post: postId },
      {
        status: "action_taken",
        adminNotes: "Post deleted by admin",
        reviewedBy: (req as any).user._id,
        reviewedAt: new Date(),
      }
    );
    
    res.status(200).json({ success: true, message: "Post deleted and reports resolved" });
  } catch (error: any) {
    console.error("Delete Reported Post Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   GET REPORTED USERS
======================= */
export const getReportedUsers = async (req: Request, res: Response) => {
  try {
    const { status = "pending", page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const reports = await UserReport.find({ status })
      .populate("reportedUser", "username email profilePic userType isVerified")
      .populate("reporter", "username email")
      .populate("reviewedBy", "username")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Group reports by reported user
    const userReports = new Map<string, any>();

    for (const report of reports) {
      if (!report.reportedUser) continue;
      const userId = (report.reportedUser as any)._id.toString();

      if (!userReports.has(userId)) {
        userReports.set(userId, {
          reportedUser: report.reportedUser,
          reports: [],
          totalReports: 0,
        });
      }

      userReports.get(userId).reports.push({
        _id: report._id,
        reason: report.reason,
        customReason: report.customReason,
        reporter: report.reporter,
        createdAt: report.createdAt,
        status: report.status,
      });
      userReports.get(userId).totalReports += 1;
    }

    const total = await UserReport.countDocuments({ status });

    res.status(200).json({
      reports: Array.from(userReports.values()),
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (error: any) {
    console.error("Get Reported Users Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   UPDATE USER REPORT STATUS
======================= */
export const updateUserReportStatus = async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const { status, adminNotes } = req.body;

    const validStatuses = ["reviewed", "dismissed", "action_taken"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const report = await UserReport.findByIdAndUpdate(
      reportId,
      {
        status,
        adminNotes,
        reviewedBy: (req as any).user._id,
        reviewedAt: new Date(),
      },
      { new: true }
    );

    if (!report) {
      return res.status(404).json({ message: "User report not found" });
    }

    res.status(200).json({ success: true, report });
  } catch (error: any) {
    console.error("Update User Report Status Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* =======================
   BAN REPORTED USER
======================= */
export const banReportedUser = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: (req as any).user._id,
        deletedReason: "Banned by admin due to user reports",
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update all reports for this user to "action_taken"
    await UserReport.updateMany(
      { reportedUser: userId },
      {
        status: "action_taken",
        adminNotes: "User banned by admin",
        reviewedBy: (req as any).user._id,
        reviewedAt: new Date(),
      }
    );

    res.status(200).json({ success: true, message: "User banned and reports resolved" });
  } catch (error: any) {
    console.error("Ban Reported User Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ==========================================
// ADMIN PROFILE: Update display name & profile photo
// ==========================================
export const updateAdminProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const { name } = req.body;
    const file = req.file;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Update display name if provided
    if (name && name.trim()) {
      user.name = name.trim();
    }

    // Upload profile photo if provided
    if (file) {
      const { uploadFile } = await import("../utils/cloudflareR2.js");
      const result = await uploadFile(file, "public");
      user.profilePic = result.Location;
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        _id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        profilePic: user.profilePic,
        userType: user.userType,
      },
    });
  } catch (error: any) {
    console.error("Update Admin Profile Error:", error);
    res.status(500).json({ message: error.message });
  }
};

export const getAdminProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const user = await User.findById(userId).select("name username email profilePic userType");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ success: true, user });
  } catch (error: any) {
    console.error("Get Admin Profile Error:", error);
    res.status(500).json({ message: error.message });
  }
};
