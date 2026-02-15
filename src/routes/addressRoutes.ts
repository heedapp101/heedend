import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  getSavedAddresses,
  createSavedAddress,
  updateSavedAddress,
  deleteSavedAddress,
  setDefaultAddress,
} from "../controllers/addressController.js";

const router = Router();

router.get("/", requireAuth, getSavedAddresses);
router.post("/", requireAuth, createSavedAddress);
router.put("/:id", requireAuth, updateSavedAddress);
router.delete("/:id", requireAuth, deleteSavedAddress);
router.put("/:id/default", requireAuth, setDefaultAddress);

export default router;
