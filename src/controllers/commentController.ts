import { Response } from "express";
import Comment from "../models/Comment.js";
import ImagePost from "../models/ImagePost.js";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { INTEREST_WEIGHTS } from "../utils/interestUtils.js";
import { interestBuffer } from "../utils/InterestBuffer.js";
import { notifyComment } from "../utils/notificationService.js";

// --- GET COMMENTS FOR A POST ---
export const getComments = async (req: AuthRequest, res: Response) => {
  try {
    const { postId } = req.params;
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;
    const currentUserId = req.user?._id?.toString();
    
    // Fetch paginated comments for this post
    const [comments, total] = await Promise.all([
      Comment.find({ post: postId })
        .populate("user", "username name companyName userType profilePic isVerified") // Populate commenter info
        .sort({ createdAt: -1 }) // Newest first
        .skip(skip)
        .limit(limit)
        .lean(),
      Comment.countDocuments({ post: postId }),
    ]);

    // Transform for frontend
    const formattedComments = comments.map((c: any) => {
      const user = c.user || {};
      const likes = Array.isArray(c.likes) ? c.likes : [];
      const isLikedByMe = currentUserId
        ? likes.some((id: any) => id?.toString() === currentUserId)
        : false;

      return {
        id: c._id,
        userId: user._id,
        user: {
          id: user._id,
          username: user.username,
          name: user.name,
          companyName: user.companyName,
          userType: user.userType,
          avatarUrl: user.profilePic || "",
          isVerified: user.isVerified,
        },
        text: c.text,
        createdAt: c.createdAt,
        likesCount: likes.length,
        isLikedByMe,
        parentId: c.parentId,
      };
    });

    res.json({
      comments: formattedComments,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching comments" });
  }
};

// --- ADD A COMMENT ---
export const addComment = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { postId, text, parentId } = req.body;

    // Check if post exists and allows comments
    const post = await ImagePost.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });
    if (post.allowComments === false) return res.status(403).json({ message: "Comments are disabled for this post" });

    const newComment = await Comment.create({
      post: postId,
      user: req.user._id,
      text,
      parentId: parentId || null
    });

    // Increment comments count
    await ImagePost.updateOne({ _id: postId }, { $inc: { commentsCount: 1 } });

    // 🚀 BUFFERED: Add Comment Weight (batched every 30s)
    if (post.tags && post.tags.length > 0) {
      interestBuffer.add(req.user._id.toString(), post.tags, INTEREST_WEIGHTS.COMMENT);
    }

    // 🔔 Send notification to post owner (if not the same user)
    const postOwnerId = post.user.toString();
    if (postOwnerId !== req.user._id.toString()) {
      await notifyComment(
        postOwnerId,
        req.user._id.toString(),
        req.user.name || req.user.username || "User",
        postId,
        newComment._id.toString(),
        text
      );
    }

    // Populate user immediately for the UI
    await newComment.populate("user", "username name companyName userType profilePic isVerified");

    res.status(201).json({
      id: newComment._id,
      userId: req.user._id,
      user: {
        id: req.user._id,
        username: (newComment.user as any).username,
        name: (newComment.user as any).name,
        companyName: (newComment.user as any).companyName,
        userType: (newComment.user as any).userType,
        avatarUrl: (newComment.user as any).profilePic || "",
        isVerified: (newComment.user as any).isVerified
      },
      text: newComment.text,
      createdAt: newComment.createdAt,
      likesCount: 0,
      isLikedByMe: false,
      parentId: newComment.parentId
    });

  } catch (err) {
    res.status(500).json({ message: "Error posting comment" });
  }
};

// --- DELETE COMMENT ---
export const deleteComment = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { commentId } = req.params;

    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    // Allow deletion if user owns the comment OR user owns the post
    // (For now, just comment owner)
    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const aggregateResult = await Comment.aggregate([
      { $match: { _id: comment._id } },
      {
        $graphLookup: {
          from: "comments",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "parentId",
          as: "descendants",
          restrictSearchWithMatch: { post: comment.post },
        },
      },
      {
        $project: {
          ids: { $concatArrays: [["$_id"], "$descendants._id"] },
        },
      },
    ]);

    const idsToDelete = aggregateResult[0]?.ids || [comment._id];

    await Comment.deleteMany({ _id: { $in: idsToDelete } });
    await ImagePost.updateOne(
      { _id: comment.post },
      { $inc: { commentsCount: -1 * idsToDelete.length } }
    );
    await ImagePost.updateOne(
      { _id: comment.post, commentsCount: { $lt: 0 } },
      { $set: { commentsCount: 0 } }
    );
    res.json({ message: "Deleted successfully", deletedCount: idsToDelete.length });

  } catch (err) {
    res.status(500).json({ message: "Error deleting comment" });
  }
};

// --- LIKE COMMENT ---
export const toggleLikeComment = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { commentId } = req.params;

    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const userId = req.user._id;
    const index = comment.likes.indexOf(userId);

    if (index === -1) {
      comment.likes.push(userId); // Like
    } else {
      comment.likes.splice(index, 1); // Unlike
    }

    await comment.save();
    res.json({ likesCount: comment.likes.length, isLiked: index === -1 });

  } catch (err) {
    res.status(500).json({ message: "Error liking comment" });
  }
};
