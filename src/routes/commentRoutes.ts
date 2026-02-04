import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { 
  getComments, 
  addComment, 
  deleteComment, 
  toggleLikeComment 
} from "../controllers/commentController.js";

const router = Router();

router.get("/:postId", requireAuth, getComments); // Get all comments for a post
router.post("/", requireAuth, addComment);        // Add a new comment
router.delete("/:commentId", requireAuth, deleteComment); // Delete a comment
router.post("/:commentId/like", requireAuth, toggleLikeComment); // Toggle like

export default router;