import express from "express";
import { 
  signup, 
  login, 
  googleAuth,
  generateUploadUrl, 
  uploadImage,
  getPrivateDocument,
  checkUsername,
  checkDuplicates,
  sendOtp,
  verifyOtp
} from "../controllers/authController.js";
import { upload } from "../middleware/upload.js";

const router = express.Router();

router.get("/ping", (req, res) => {
  res.status(200).json({
    message: "Backend is reachable 🎯",
    time: new Date().toISOString(),
    serverIp: req.hostname,
  });
});

// ✅ Validation endpoints
router.post("/check-username", checkUsername);
router.post("/check-duplicates", checkDuplicates);
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

// ✅ New Route for Frontend Image Upload
router.post("/upload-image", upload.single("file"), uploadImage);

// Keep the old one for reference if needed, but we aren't using it for profile anymore
router.get("/upload-url", generateUploadUrl);

router.post("/signup", signup);
router.post("/login", login);
router.post("/google", googleAuth); // ✅ Google Sign In

// ✅ NEW: Get private documents (documents, ID proofs, etc)
router.get("/document/:filename", getPrivateDocument);

export default router;