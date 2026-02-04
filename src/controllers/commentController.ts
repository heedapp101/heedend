import { Response } from "express";
import Comment from "../models/Comment.js";
import ImagePost from "../models/ImagePost.js";
import { AuthRequest } from "../middleware/authMiddleware.js";
import mongoose from "mongoose";
import { INTEREST_WEIGHTS } from "../utils/interestUtils.js";
import { interestBuffer } from "../utils/InterestBuffer.js";
import { notifyComment } from "../utils/notificationService.js";

// --- GET COMMENTS FOR A POST ---
export const getComments = async (req: AuthRequest, res: Response) => {
  try {
    const { postId } = req.params;
    
    // Fetch all comments for this post
    const comments = await Comment.find({ post: postId })
      .populate("user", "username profilePic isVerified") // Populate commenter info
      .sort({ createdAt: -1 }); // Newest first

    // Transform for frontend
    const formattedComments = comments.map(c => ({
      id: c._id,
      userId: (c.user as any)._id,
      user: {
        id: (c.user as any)._id,
        username: (c.user as any).username,
        avatarUrl: (c.user as any).profilePic || "", 
        isVerified: (c.user as any).isVerified
      },
      text: c.text,
      createdAt: c.createdAt,
      likesCount: c.likes.length,
      isLikedByMe: req.user ? c.likes.includes(req.user._id) : false,
      parentId: c.parentId,
    }));

    res.json(formattedComments);
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
    await newComment.populate("user", "username profilePic isVerified");

    res.status(201).json({
      id: newComment._id,
      userId: req.user._id,
      user: {
        id: req.user._id,
        username: (newComment.user as any).username,
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

    await comment.deleteOne();
    res.json({ message: "Deleted successfully" });

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