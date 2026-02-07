import { Router } from "express";
import rateLimit from "express-rate-limit";
import { searchAll } from "../controllers/searchController.js";

const router = Router();

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { message: "Too many search requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/", searchLimiter, searchAll);

export default router;
