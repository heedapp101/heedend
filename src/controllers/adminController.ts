import { Request, Response } from "express";
import User from "../models/User.js";
import ImagePost from "../models/ImagePost.js";
import RecommendationAnalytics from "../models/RecommendationAnalytics.js";
import Report from "../models/Report.js";
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
    const { role, search, sortBy, order } = req.query;

    // 1. Match Stage (Filtering)
    const matchStage: any = {};
    
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
          userType: 1,
          profilePic: 1,
          isVerified: 1,
          createdAt: 1,
          interests: 1,
          location: 1,
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

    res.status(200).json(users);
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
    const totalUsers = await User.countDocuments();
    const businessUsers = await User.countDocuments({ userType: "business" });
    const pendingApprovals = await User.countDocuments({ userType: "business", isVerified: false });
    const totalPosts = await ImagePost.countDocuments();

    // 2. Graph Data: User Growth (Last 7 Days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const userGrowth = await User.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          users: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // 3. Recent Activity (Newest 5 Users)
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("username email userType createdAt");

    res.status(200).json({
      stats: {
        totalUsers,
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
   GET REPORTED POSTS
======================= */
export const getReportedPosts = async (req: Request, res: Response) => {
  try {
    const { status = "pending", page = 1, limit = 20 } = req.query;
    
    const skip = (Number(page) - 1) * Number(limit);
    
    const reports = await Report.find({ status })
      .populate("post", "title images user createdAt")
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
