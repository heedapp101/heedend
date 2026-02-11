import { Request, Response } from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import Follow from "../models/Follow.js";
import Collection from "../models/Collection.js";
import ImagePost from "../models/ImagePost.js";
import Comment from "../models/Comment.js";
import Notification from "../models/Notification.js";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { INTEREST_WEIGHTS } from "../utils/interestUtils.js";
import { interestBuffer } from "../utils/InterestBuffer.js";
import { notifyFollow } from "../utils/notificationService.js";
import PostLike from "../models/PostLike.js";
import PostView from "../models/PostView.js";

const hasPaymentDetails = (details?: Record<string, any>): boolean => {
  if (!details) return false;
  return Object.values(details).some((value) => {
    if (typeof value !== "string") return false;
    return value.trim().length > 0;
  });
};

// GET CURRENT USER (for token validation)
export const getCurrentUser = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    
    const user = await User.findById(req.user._id).select("-password");
    if (!user || (user as any).isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }
    
    res.json(user);
  } catch (err) {
    console.error("Get Current User Error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// FOLLOW USER
export const followUser = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params; 
    const currentUserId = req.user._id;

    if (id === currentUserId.toString()) {
      return res.status(400).json({ message: "Cannot follow yourself" });
    }

    // Check if user to follow exists
    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const existing = await Follow.findOne({ follower: currentUserId, following: id }).select("_id").lean();
    if (existing) {
      return res.status(400).json({ message: "Already following this user" });
    }

    try {
      await Follow.create({ follower: currentUserId, following: id });
      await Promise.all([
        User.updateOne({ _id: currentUserId }, { $inc: { followingCount: 1 } }),
        User.updateOne({ _id: id }, { $inc: { followersCount: 1 } }),
      ]);
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(400).json({ message: "Already following this user" });
      }
      throw err;
    }

    // Send follow notification
    await notifyFollow(id, currentUserId.toString(), req.user.name || req.user.username || "User");

    // Get updated counts
    const updatedTarget = await User.findById(id).select("followersCount");
    const updatedCurrent = await User.findById(currentUserId).select("followingCount");

    res.json({ 
      message: "Followed successfully",
      isFollowing: true,
      followersCount: (updatedTarget as any)?.followersCount || 0,
      followingCount: (updatedCurrent as any)?.followingCount || 0,
    });
  } catch (err) {
    console.error("Follow Error:", err);
    res.status(500).json({ message: "Error following user" });
  }
};

// UNFOLLOW USER
export const unfollowUser = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const currentUserId = req.user._id;

    if (id === currentUserId.toString()) {
      return res.status(400).json({ message: "Cannot unfollow yourself" });
    }

    // Check if user exists
    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const deleted = await Follow.deleteOne({ follower: currentUserId, following: id });
    if (deleted.deletedCount) {
      await Promise.all([
        User.updateOne({ _id: currentUserId }, { $inc: { followingCount: -1 }, $max: { followingCount: 0 } }),
        User.updateOne({ _id: id }, { $inc: { followersCount: -1 }, $max: { followersCount: 0 } }),
      ]);
    }

    // Get updated counts
    const updatedTarget = await User.findById(id).select("followersCount");
    const updatedCurrent = await User.findById(currentUserId).select("followingCount");

    res.json({ 
      message: "Unfollowed successfully",
      isFollowing: false,
      followersCount: (updatedTarget as any)?.followersCount || 0,
      followingCount: (updatedCurrent as any)?.followingCount || 0,
    });
  } catch (err) {
    console.error("Unfollow Error:", err);
    res.status(500).json({ message: "Error unfollowing user" });
  }
};

// CHECK IF FOLLOWING
export const checkFollowStatus = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;

    const isFollowing = !!(await Follow.exists({ follower: req.user._id, following: id }));

    res.json({ isFollowing });
  } catch (err) {
    console.error("Check Follow Status Error:", err);
    res.status(500).json({ message: "Error checking follow status" });
  }
};

// GET PROFILE (User Data + Collections + Counts)
export const getUserProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid User ID format" });
    }

    const user = await User.findById(id).select("-password -paymentDetails");
    if (!user || (user as any).isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ FIX: Populate 'posts' so frontend gets images, not just IDs
    let collections: any[] = [];
    try {
       collections = await Collection.find({ user: id })
         .populate({
            path: 'posts',
            select: 'images title price', // Select fields needed for display
         });
    } catch (collectionErr) {
       console.error("Collection Fetch Error:", collectionErr);
       collections = [];
    }

    res.json({
      user,
      followersCount: (user as any).followersCount || 0,
      followingCount: (user as any).followingCount || 0,
      collections
    });

  } catch (err) {
    console.error("SERVER PROFILE ERROR:", err);
    res.status(500).json({ message: "Server error fetching profile" });
  }
};

// CREATE NEW GROUP (Collection)
export const createCollection = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { name, isPrivate } = req.body;

    const newCollection = await Collection.create({
      user: req.user._id,
      name,
      isPrivate: !!isPrivate,
      posts: []
    });

    res.status(201).json(newCollection);
  } catch (err) {
    res.status(500).json({ message: "Error creating collection" });
  }
};

// TOGGLE POST IN COLLECTION (TUCK-IN)
export const toggleCollectionItem = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { collectionId } = req.params;
    const { postId } = req.body;

    if (!postId) return res.status(400).json({ message: "Post ID required" });

    const normalizedPostId = String(postId);
    if (!mongoose.Types.ObjectId.isValid(normalizedPostId)) {
      return res.status(400).json({ message: "Invalid Post ID" });
    }

    const collection = await Collection.findOne({ _id: collectionId, user: req.user._id });
    if (!collection) return res.status(404).json({ message: "Collection not found" });

    const exists = collection.posts.some((p: any) => p.toString() === normalizedPostId);

    if (exists) {
      collection.posts = collection.posts.filter((p: any) => p.toString() !== normalizedPostId);
    } else {
      collection.posts.push(new mongoose.Types.ObjectId(normalizedPostId) as any);

      // Buffer save-intent weight for recommendations
      const post = await ImagePost.findById(normalizedPostId);
      if (post && post.tags && post.tags.length > 0) {
        interestBuffer.add(req.user._id.toString(), post.tags, INTEREST_WEIGHTS.SAVE);
      }
    }

    await collection.save();

    res.json({
      message: exists ? "Removed from collection" : "Added to collection",
      added: !exists,
      collection,
    });
  } catch (err) {
    console.error("Collection Toggle Error:", err);
    res.status(500).json({ message: "Error updating collection" });
  }
};
// UPDATE USER PROFILE
export const updateUserProfile = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const {
      name,
      bio,
      location,
      showLocation,
      profilePic,
      bannerImg,
      companyName,
      address,
      gstNumber,
      country,
      requireChatBeforePurchase,
      autoReplyEnabled,
      autoReplyMessage,
      customQuickQuestion,
      inventoryAlertThreshold,
    } = req.body;

    // Validate required fields
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }

    if (req.user.userType === "business" && (!companyName || !companyName.trim())) {
      return res.status(400).json({ message: "Company Name is required for business users" });
    }

    // Build update object
    const updateData: any = {
      name: name.trim(),
      bio: bio?.trim() || "",
      location: location?.trim() || "",
      showLocation: showLocation !== undefined ? showLocation : true, // ✅ Include showLocation toggle
      profilePic: profilePic || "",
      bannerImg: bannerImg || "",
      nameLower: name.trim().toLowerCase(),
    };

    // Add business fields if business user
    if (req.user.userType === "business") {
      updateData.companyName = companyName?.trim() || "";
      updateData.companyNameLower = updateData.companyName.toLowerCase();
      updateData.address = address?.trim() || "";
      updateData.gstNumber = gstNumber?.trim() || "";
      updateData.country = country?.trim() || "";
      updateData.requireChatBeforePurchase = requireChatBeforePurchase !== false;
      updateData.autoReplyEnabled = !!autoReplyEnabled;
      updateData.autoReplyMessage = autoReplyMessage?.trim() || "Thanks for your message. We will reply soon.";
      updateData.customQuickQuestion = customQuickQuestion?.trim() || "";
      updateData.inventoryAlertThreshold =
        inventoryAlertThreshold && Number(inventoryAlertThreshold) > 0
          ? Number(inventoryAlertThreshold)
          : 3;
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true, runValidators: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      message: "Profile updated successfully",
      user: updatedUser
    });

  } catch (err: any) {
    console.error("Update Profile Error:", err);
    res.status(500).json({ 
      message: err.message || "Error updating profile"
    });
  }
};

// GET USER'S FOLLOWERS LIST
export const getFollowersList = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid User ID format" });
    }

    const user = await User.findById(id).select("_id");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const total = await Follow.countDocuments({ following: user._id });
    const followDocs = await Follow.find({ following: user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("follower")
      .lean();

    const followerIds = followDocs.map((f: any) => f.follower);
    const followerUsers = await User.find({ _id: { $in: followerIds } })
      .select("username name profilePic userType companyName")
      .lean();

    const userMap = new Map(
      followerUsers.map((u: any) => [u._id.toString(), u])
    );

    let followingSet = new Set<string>();
    if (currentUserId && followerIds.length > 0) {
      const followingDocs = await Follow.find({
        follower: currentUserId,
        following: { $in: followerIds },
      }).select("following").lean();
      followingSet = new Set(followingDocs.map((d: any) => d.following.toString()));
    }

    const followers = followerIds
      .map((id: any) => {
        const u = userMap.get(id.toString());
        if (!u) return null;
        return {
          _id: u._id,
          username: u.username,
          name: u.name,
          profilePic: u.profilePic,
          userType: u.userType,
          companyName: u.companyName,
          isFollowing: followingSet.has(u._id.toString()),
        };
      })
      .filter(Boolean);

    res.json({
      users: followers,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Get Followers Error:", err);
    res.status(500).json({ message: "Error fetching followers" });
  }
};

// GET USER'S FOLLOWING LIST
export const getFollowingList = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid User ID format" });
    }

    const user = await User.findById(id).select("_id");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const total = await Follow.countDocuments({ follower: user._id });
    const followDocs = await Follow.find({ follower: user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("following")
      .lean();

    const followingIds = followDocs.map((f: any) => f.following);
    const followingUsers = await User.find({ _id: { $in: followingIds } })
      .select("username name profilePic userType companyName")
      .lean();

    const userMap = new Map(
      followingUsers.map((u: any) => [u._id.toString(), u])
    );

    let followingSet = new Set<string>();
    if (currentUserId && followingIds.length > 0) {
      const followingDocsForCurrent = await Follow.find({
        follower: currentUserId,
        following: { $in: followingIds },
      }).select("following").lean();
      followingSet = new Set(followingDocsForCurrent.map((d: any) => d.following.toString()));
    }

    const following = followingIds
      .map((id: any) => {
        const u = userMap.get(id.toString());
        if (!u) return null;
        return {
          _id: u._id,
          username: u.username,
          name: u.name,
          profilePic: u.profilePic,
          userType: u.userType,
          companyName: u.companyName,
          isFollowing: followingSet.has(u._id.toString()),
        };
      })
      .filter(Boolean);

    res.json({
      users: following,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Get Following Error:", err);
    res.status(500).json({ message: "Error fetching following list" });
  }
};

// ====== PUSH NOTIFICATION TOKEN MANAGEMENT ======

// Save push token
export const savePushToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { pushToken, platform } = req.body;
    const EXPO_PUSH_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!pushToken) {
      return res.status(400).json({ message: "Push token is required" });
    }

    const trimmedToken = String(pushToken).trim();
    if (!EXPO_PUSH_TOKEN_PATTERN.test(trimmedToken)) {
      return res.status(400).json({ message: "Invalid Expo push token format" });
    }

    const normalizedPlatform =
      platform === "ios" || platform === "android" ? platform : "unknown";

    // Ensure this token is bound to only one user at a time.
    await User.updateMany(
      { _id: { $ne: userId } },
      { $pull: { pushTokens: { token: trimmedToken } } }
    );

    // Use update operators instead of user.save() so push-token writes are not blocked
    // by unrelated pre-save validation rules on user profiles.
    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $pull: { pushTokens: { token: trimmedToken } },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    await User.updateOne(
      { _id: userId },
      {
        $push: {
          pushTokens: {
            $each: [
              {
                token: trimmedToken,
                platform: normalizedPlatform,
                createdAt: new Date(),
              },
            ],
            $slice: -10,
          },
        },
      }
    );

    res.json({ message: "Push token saved successfully", token: trimmedToken });
  } catch (err) {
    console.error("Save Push Token Error:", err);
    res.status(500).json({ message: "Error saving push token" });
  }
};

// GET MY PAYMENT DETAILS (Seller)
export const getMyPaymentDetails = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(req.user._id).select("userType paymentDetails");
    if (!user || (user as any).isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      paymentDetails: (user as any).paymentDetails || {},
      hasPaymentDetails: hasPaymentDetails((user as any).paymentDetails),
    });
  } catch (err) {
    console.error("Get payment details error:", err);
    res.status(500).json({ message: "Failed to fetch payment details" });
  }
};

// UPDATE MY PAYMENT DETAILS (Seller)
export const updatePaymentDetails = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(req.user._id).select("userType paymentDetails");
    if (!user || (user as any).isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.userType !== "business") {
      return res.status(403).json({ message: "Only business accounts can update payment details" });
    }

    const {
      upiId,
      accountHolderName,
      accountNumber,
      ifsc,
      bankName,
      phone,
      note,
    } = req.body || {};

    const paymentDetails = {
      upiId: upiId?.trim() || "",
      accountHolderName: accountHolderName?.trim() || "",
      accountNumber: accountNumber?.trim() || "",
      ifsc: ifsc?.trim() || "",
      bankName: bankName?.trim() || "",
      phone: phone?.trim() || "",
      note: note?.trim() || "",
    };

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { paymentDetails },
      { new: true, runValidators: true }
    ).select("paymentDetails");

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      message: "Payment details updated",
      paymentDetails: (updatedUser as any).paymentDetails || {},
      hasPaymentDetails: hasPaymentDetails((updatedUser as any).paymentDetails),
    });
  } catch (err: any) {
    console.error("Update payment details error:", err);
    res.status(500).json({ message: err.message || "Failed to update payment details" });
  }
};

// GET SELLER PAYMENT DETAILS (Buyer view)
export const getSellerPaymentDetails = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid User ID format" });
    }

    const seller = await User.findById(id).select("username companyName userType paymentDetails");
    if (!seller || (seller as any).isDeleted) {
      return res.status(404).json({ message: "Seller not found" });
    }

    if (seller.userType !== "business") {
      return res.status(404).json({ message: "Seller not found" });
    }

    const details = (seller as any).paymentDetails || {};

    res.json({
      seller: {
        _id: seller._id,
        username: seller.username,
        companyName: seller.companyName,
      },
      paymentDetails: details,
      hasPaymentDetails: hasPaymentDetails(details),
    });
  } catch (err) {
    console.error("Get seller payment details error:", err);
    res.status(500).json({ message: "Failed to fetch seller payment details" });
  }
};

// Remove push token
export const removePushToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { pushToken } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const query = { _id: userId };
    const update = pushToken
      ? { $pull: { pushTokens: { token: String(pushToken).trim() } } }
      : { $set: { pushTokens: [] } };

    const updated = await User.findByIdAndUpdate(query, update, { new: true });
    if (!updated) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "Push token removed successfully" });
  } catch (err) {
    console.error("Remove Push Token Error:", err);
    res.status(500).json({ message: "Error removing push token" });
  }
};

// DELETE MY ACCOUNT (Soft-delete with data cleanup)
export const deleteMyAccount = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if ((user as any).isDeleted) {
      return res.status(400).json({ message: "Account already deleted" });
    }

    const { reason } = req.body as { reason?: string };
    const deletedAt = new Date();

    // Remove user from follow graph and decrement counts
    const [followersDocs, followingDocs] = await Promise.all([
      Follow.find({ following: user._id }).select("follower").lean(),
      Follow.find({ follower: user._id }).select("following").lean(),
    ]);

    const followerIds = followersDocs.map((f: any) => f.follower);
    const followingIds = followingDocs.map((f: any) => f.following);

    await Promise.all([
      followerIds.length
        ? User.updateMany(
            { _id: { $in: followerIds } },
            { $inc: { followingCount: -1 }, $max: { followingCount: 0 } }
          )
        : Promise.resolve(),
      followingIds.length
        ? User.updateMany(
            { _id: { $in: followingIds } },
            { $inc: { followersCount: -1 }, $max: { followersCount: 0 } }
          )
        : Promise.resolve(),
      Follow.deleteMany({ $or: [{ follower: user._id }, { following: user._id }] }),
    ]);

    // Delete user-generated content
    await ImagePost.deleteMany({ user: user._id });
    await Collection.deleteMany({ user: user._id });
    await Comment.deleteMany({ user: user._id });
    await Notification.deleteMany({ $or: [{ recipient: user._id }, { sender: user._id }] });
    await PostLike.deleteMany({ user: user._id });
    await PostView.deleteMany({ user: user._id });

    // Anonymize the user and mark as deleted
    const anonymizedEmail = `deleted+${user._id.toString()}@heed.app`;
    const anonymizedUsername = `deleted_${user._id.toString().slice(-8)}`;

    user.email = anonymizedEmail;
    user.username = anonymizedUsername;
    user.name = "Deleted User";
    user.phone = "";
    user.bio = "";
    user.profilePic = "";
    user.bannerImg = "";
    user.location = "";
    user.interests = [];
    user.pushTokens = [];
    (user as any).isDeleted = true;
    (user as any).deletedAt = deletedAt;
    (user as any).deletedReason = reason?.trim() || "user_request";
    (user as any).deletedBy = "user";

    await user.save();

    res.status(200).json({ success: true, deletedAt });
  } catch (err: any) {
    console.error("Delete Account Error:", err);
    res.status(500).json({ message: "Failed to delete account" });
  }
};
