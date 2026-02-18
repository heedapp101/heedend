import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import User from "../models/User.js";
import LegalDocument from "../models/LegalDocument.js";
import { getPresignedUrl } from "../cloudflare.js";
import { uploadFile, s3 } from "../utils/cloudflareR2.js";
import { processImage } from "../utils/ProcessImage.js";
import { sendOtpSMS } from "../services/twilioService.js";

// In-memory OTP store (use Redis in production)
const otpStore = new Map<string, { otp: string; expiresAt: number; verified: boolean }>();

/* =======================
   CHECK USERNAME AVAILABILITY
   Returns suggestions if taken
======================= */
export const checkUsername = async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    
    if (!username || username.length < 3) {
      return res.status(400).json({ message: "Username must be at least 3 characters" });
    }

    const normalizedUsername = username.toLowerCase().trim();
    const existingUser = await User.findOne({ username: normalizedUsername });

    if (!existingUser) {
      return res.status(200).json({ 
        available: true, 
        username: normalizedUsername 
      });
    }

    // Generate suggestions
    const suggestions: string[] = [];
    const baseUsername = normalizedUsername.replace(/[0-9_]+$/, ''); // Remove trailing numbers/underscores
    
    // Try with random numbers
    for (let i = 0; i < 5; i++) {
      const suffix = Math.floor(Math.random() * 9999);
      const suggestion = `${baseUsername}${suffix}`;
      const exists = await User.findOne({ username: suggestion });
      if (!exists && !suggestions.includes(suggestion)) {
        suggestions.push(suggestion);
      }
      if (suggestions.length >= 3) break;
    }

    // Try with underscores
    if (suggestions.length < 3) {
      const withUnderscore = `${baseUsername}_${Math.floor(Math.random() * 99)}`;
      const exists = await User.findOne({ username: withUnderscore });
      if (!exists) suggestions.push(withUnderscore);
    }

    return res.status(200).json({ 
      available: false, 
      message: "Username already taken",
      suggestions 
    });
  } catch (error: any) {
    console.error("Check Username Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

/* =======================
   CHECK EMAIL/PHONE DUPLICATES
======================= */
export const checkDuplicates = async (req: Request, res: Response) => {
  try {
    const { email, phone } = req.body;
    const result: { emailExists: boolean; phoneExists: boolean } = {
      emailExists: false,
      phoneExists: false,
    };

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existingEmail = await User.findOne({ email: normalizedEmail });
      result.emailExists = !!existingEmail;
    }

    if (phone) {
      const existingPhone = await User.findOne({ phone: phone.trim() });
      result.phoneExists = !!existingPhone;
    }

    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Check Duplicates Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

/* =======================
   SEND OTP TO PHONE
   (Uses console log for development - integrate SMS gateway for production)
======================= */
export const sendOtp = async (req: Request, res: Response) => {
  try {
    const { phone, countryCode = "+91" } = req.body;
    
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: "Please provide a valid 10-digit phone number" });
    }

    const fullPhone = `${countryCode}${phone}`;
    
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiry

    // Store OTP
    otpStore.set(fullPhone, { otp, expiresAt, verified: false });

    // Clean up expired OTPs periodically
    setTimeout(() => {
      const stored = otpStore.get(fullPhone);
      if (stored && stored.expiresAt < Date.now()) {
        otpStore.delete(fullPhone);
      }
    }, 5 * 60 * 1000);

    // Send OTP via Twilio (falls back to console.log in dev if not configured)
    await sendOtpSMS(fullPhone, otp);

    return res.status(200).json({ 
      message: "OTP sent successfully",
      // Remove in production - only for testing
      ...(process.env.NODE_ENV === 'development' && { testOtp: otp })
    });
  } catch (error: any) {
    console.error("Send OTP Error:", error);
    return res.status(500).json({ message: "Failed to send OTP" });
  }
};

/* =======================
   VERIFY OTP
======================= */
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, countryCode = "+91", otp } = req.body;
    
    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP are required" });
    }

    const fullPhone = `${countryCode}${phone}`;
    const stored = otpStore.get(fullPhone);

    if (!stored) {
      return res.status(400).json({ message: "OTP expired or not found. Please request a new one." });
    }

    if (stored.expiresAt < Date.now()) {
      otpStore.delete(fullPhone);
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP. Please try again." });
    }

    // Mark as verified
    stored.verified = true;
    otpStore.set(fullPhone, stored);

    return res.status(200).json({ 
      message: "Phone verified successfully",
      verified: true 
    });
  } catch (error: any) {
    console.error("Verify OTP Error:", error);
    return res.status(500).json({ message: "Verification failed" });
  }
};

/* =======================
   REQUEST BODY TYPES
======================= */

interface SignupRequestBody {
  userType: "general" | "business";
  username: string;
  email: string;
  password: string;
  name: string;
  phone: string;
  legalAcceptances?: { docId: string; version: number }[];
  
  // Optional / Specific fields
  bio?: string;
  profilePic?: string;
  bannerImg?: string;
  location?: string;
  age?: string; // Frontend might send as string
  gender?: "Male" | "Female" | "Other";
  interests?: string[];
  
  // Business fields
  companyName?: string;
  address?: string;
  country?: string;
  
  // ID Proof (GST and Driving License accepted for new onboarding)
  idProofType?: 'GST' | 'Driving License' | 'PAN' | 'Aadhaar';
  idProofNumber?: string;
  idProofUrl?: string;
  
  // Business Delivery Options
  productType?: string;
  cashOnDeliveryAvailable?: boolean;
  allIndiaDelivery?: boolean;
  freeShipping?: boolean;
  returnPolicy?: string;
  requireChatBeforePurchase?: boolean;
  autoReplyEnabled?: boolean;
  autoReplyMessage?: string;
  customQuickQuestion?: string;
  inventoryAlertThreshold?: number;
}

interface LoginRequestBody {
  emailOrUsername: string;
  password: string;
}

/* =======================
   GENERATE UPLOAD URL
======================= */
export const generateUploadUrl = async (req: Request, res: Response) => {
  try {
    const { folder, fileType } = req.query;
    
    if (!folder || !fileType) {
      return res.status(400).json({ message: "Folder and fileType are required" });
    }

    const urls = await getPresignedUrl(folder as string, fileType as string);
    res.json(urls);
  } catch (error: any) {
    console.error("Generate URL Error:", error);
    res.status(500).json({ message: "Server error generating upload URL" });
  }
};

/* =======================
        SIGNUP
======================= */
export const signup = async (
  req: Request<{}, {}, SignupRequestBody>,
  res: Response
) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET!;
    if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined in .env");

    const {
      userType,
      username,
      email,
      password,
      name,
      phone,
      legalAcceptances,
      bio,
      profilePic,
      bannerImg,
      location,
      age,
      gender,
      interests,
      companyName,
      address,
      country,
      // ID Proof
      idProofType,
      idProofNumber,
      idProofUrl,
      // Delivery Options
      productType,
      cashOnDeliveryAvailable,
      allIndiaDelivery,
      freeShipping,
      returnPolicy,
      requireChatBeforePurchase,
      autoReplyEnabled,
      autoReplyMessage,
      customQuickQuestion,
      inventoryAlertThreshold,
    } = req.body;

    // 🔒 SECURITY: Block admin account creation via API (runtime check for raw requests)
    if ((req.body as any).userType === "admin") {
      return res.status(403).json({ message: "Admin accounts cannot be created via signup" });
    }

    // 1. Basic Validation
    if (!userType || !username || !email || !password || !name || !phone) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 1b. Business ID proof validation
    if (userType === "business") {
      const activeIdProofTypes = new Set(["GST", "Driving License"]);

      if (!idProofType) {
        return res.status(400).json({ message: "ID proof type is required for business accounts" });
      }

      if (!activeIdProofTypes.has(String(idProofType))) {
        return res.status(400).json({
          message: "Only GST or Driving License is allowed for business verification",
        });
      }
    }

    // 2. Check Duplicates
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();

    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
    });

    if (existingUser) {
      if (existingUser.email === normalizedEmail) {
        return res.status(400).json({ message: "Email already exists" });
      }
      if (existingUser.username === normalizedUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }
    }

    // 3. Hash Password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3b. Validate legal acceptance (required docs)
    const requiredDocs = await LegalDocument.find({ isActive: true, isRequired: true })
      .select("_id version");
    if (requiredDocs.length > 0) {
      if (!Array.isArray(legalAcceptances) || legalAcceptances.length === 0) {
        return res.status(400).json({ message: "Legal acceptance required" });
      }
      const acceptanceMap = new Map<string, number>();
      legalAcceptances.forEach((acc) => {
        if (!acc?.docId) return;
        acceptanceMap.set(String(acc.docId), Number(acc.version || 0));
      });
      const missing = requiredDocs.find((doc) => {
        const acceptedVersion = acceptanceMap.get(String(doc._id)) || 0;
        return acceptedVersion < doc.version;
      });
      if (missing) {
        return res.status(400).json({ message: "Please accept the latest legal terms" });
      }
    }

    // 4. Create User
    const newUser = new User({
      userType,
      username: normalizedUsername,
      email: normalizedEmail,
      password: hashedPassword,
      name,
      phone,
      bio,
      profilePic,
      bannerImg,
      location,
      interests,
      
      // General specific
      age: age ? Number(age) : undefined,
      gender: (userType === "general" && gender) ? gender : undefined,

      // Business specific
      companyName: userType === "business" ? companyName : undefined,
      address: userType === "business" ? address : undefined,
      country: userType === "business" ? country : undefined,
      
      // ID Proof
      idProofType: userType === "business" ? idProofType : undefined,
      idProofNumber: userType === "business" ? idProofNumber : undefined,
      idProofUrl: userType === "business" ? idProofUrl : undefined,
      
      // Business Delivery Options
      productType: userType === "business" ? productType : undefined,
      cashOnDeliveryAvailable: userType === "business" ? cashOnDeliveryAvailable : false,
      allIndiaDelivery: userType === "business" ? allIndiaDelivery : false,
      freeShipping: userType === "business" ? freeShipping : false,
      returnPolicy: userType === "business" ? returnPolicy : undefined,
      requireChatBeforePurchase: userType === "business" ? requireChatBeforePurchase !== false : true,
      autoReplyEnabled: userType === "business" ? !!autoReplyEnabled : false,
      autoReplyMessage: userType === "business" ? autoReplyMessage : undefined,
      customQuickQuestion: userType === "business" ? customQuickQuestion : undefined,
      inventoryAlertThreshold: userType === "business"
        ? (inventoryAlertThreshold && Number(inventoryAlertThreshold) > 0 ? Number(inventoryAlertThreshold) : 3)
        : 3,
      legalAcceptances: Array.isArray(legalAcceptances)
        ? legalAcceptances.map((acc) => ({
            docId: acc.docId,
            version: acc.version,
            acceptedAt: new Date(),
          }))
        : [],
    });

    await newUser.save();

    // 5. Generate Token
    const token = jwt.sign(
      {
        _id: newUser._id,
        username: newUser.username,
        userType: newUser.userType,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      message: "User created successfully",
      token,
      // ✅ RETURN FULL USER OBJECT
      user: {
        _id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        userType: newUser.userType,
        name: newUser.name,
        phone: newUser.phone,
        isVerified: newUser.isVerified,
        bio: newUser.bio,
        profilePic: newUser.profilePic,
        bannerImg: newUser.bannerImg,
        location: newUser.location,
        interests: newUser.interests,
        companyName: newUser.companyName,
        // Business delivery options
        cashOnDeliveryAvailable: newUser.cashOnDeliveryAvailable,
        allIndiaDelivery: newUser.allIndiaDelivery,
        freeShipping: newUser.freeShipping,
        returnPolicy: newUser.returnPolicy,
        idProofType: newUser.idProofType,
        requireChatBeforePurchase: newUser.requireChatBeforePurchase,
        autoReplyEnabled: newUser.autoReplyEnabled,
        autoReplyMessage: newUser.autoReplyMessage,
        customQuickQuestion: newUser.customQuickQuestion,
        inventoryAlertThreshold: newUser.inventoryAlertThreshold,
        legalAcceptances: newUser.legalAcceptances,
      },
    });
  } catch (error: any) {
    console.error("SIGNUP BACKEND ERROR:", error);
    return res.status(500).json({ message: error.message || "Server error" });
  }
};
/* =======================
   ✅ NEW: DIRECT IMAGE UPLOAD
   (Replaces Presigned URL for stability)
   - Converts images to WebP for better compression
   - Creates high/low quality versions for progressive loading
   - Documents (PDFs) are uploaded as-is
======================= */
export const uploadImage = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    // ✅ CHECK QUERY PARAM: If frontend sends ?folder=private, use it.
    const folder = req.query.folder === "private" ? "private" : "public";

    // Check if it's an image (not a document like PDF)
    const isImage = req.file.mimetype.startsWith("image/");
    const isDocument = req.file.mimetype === "application/pdf" || 
                       req.file.mimetype.includes("document") ||
                       req.file.mimetype.includes("msword");

    console.log("📤 [Upload] Original file:", req.file.originalname, "mimetype:", req.file.mimetype, "size:", req.file.size);

    // Validate file buffer
    if (!req.file.buffer || req.file.buffer.length === 0) {
      console.error("❌ [Upload] Empty file buffer received");
      return res.status(400).json({ message: "Empty file received" });
    }

    // For documents, upload as-is
    if (isDocument || !isImage) {
      console.log("📄 [Upload] Uploading document as-is...");
      const result = await uploadFile(req.file, folder);
      return res.status(200).json({
        message: "Upload success",
        url: result.Location,
      });
    }

    // For images: Create high/low quality WebP versions
    console.log("🔄 [Upload] Processing image with high/low quality...");
    
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    try {
      const { high, low } = await processImage(req.file.buffer, filename);

      console.log("✅ [Upload] Created high/low versions:", { high, low });

      return res.status(200).json({
        message: "Upload success",
        url: high,      // Main URL is high quality
        highUrl: high,  // Explicit high quality URL
        lowUrl: low,    // Low quality for progressive loading
      });
    } catch (processError: any) {
      console.error("❌ [Upload] Image processing failed:", processError.message);
      
      // Fallback: Upload original file without processing
      console.log("⚠️ [Upload] Falling back to original file upload...");
      const result = await uploadFile(req.file, folder);
      return res.status(200).json({
        message: "Upload success (original)",
        url: result.Location,
      });
    }
  } catch (error: any) {
    console.error("❌ [Upload Image] Error:", error.message, error.stack);
    res.status(500).json({ message: error.message || "Image upload failed" });
  }
};

/* =======================
          LOGIN
======================= */
export const login = async (
  req: Request<{}, {}, LoginRequestBody>,
  res: Response
) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET!;
    if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined in .env");

    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res
        .status(400)
        .json({ message: "Email/Username and password required" });
    }

    const normalized = emailOrUsername.toLowerCase().trim();

    const user = await User.findOne({
      $or: [{ email: normalized }, { username: normalized }],
    });

    if (!user) return res.status(400).json({ message: "User not found" });
    if ((user as any).isDeleted) {
      return res.status(403).json({ message: "Account deleted" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    // Block unverified business accounts
    if (user.userType === "business" && !user.isVerified) {
      return res.status(403).json({
        message: "Business account pending admin approval",
        isVerified: false,
        userType: user.userType,
      });
    }

    const token = jwt.sign(
      {
        _id: user._id,
        username: user.username,
        userType: user.userType,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      // ✅ RETURN FULL USER OBJECT
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        userType: user.userType,
        name: user.name,
        phone: user.phone,
        isVerified: user.isVerified,
        bio: user.bio,
        profilePic: user.profilePic,
        bannerImg: user.bannerImg,
        location: user.location,
        interests: user.interests,
        companyName: user.companyName,
        requireChatBeforePurchase: user.requireChatBeforePurchase,
        autoReplyEnabled: user.autoReplyEnabled,
        autoReplyMessage: user.autoReplyMessage,
        customQuickQuestion: user.customQuickQuestion,
        inventoryAlertThreshold: user.inventoryAlertThreshold,
        legalAcceptances: user.legalAcceptances,
      },
    });
  } catch (error: any) {
    console.error("LOGIN BACKEND ERROR:", error);
    return res.status(500).json({ message: error.message || "Server error" });
  }
};

/* =======================
   GOOGLE AUTHENTICATION
   (Sign in / Sign up with Google)
   ✅ SECURE: Verifies Google token server-side
======================= */
interface GoogleAuthBody {
  idToken?: string;      // Google ID token for verification
  accessToken?: string;  // Fallback: Google access token
  email: string;
  name: string;
  googleId: string;
  profilePic?: string;
}

// Verify Google token server-side for security
async function verifyGoogleToken(idToken?: string, accessToken?: string): Promise<{
  email: string;
  name: string;
  googleId: string;
  picture?: string;
} | null> {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  
  // Method 1: Verify ID token (most secure)
  if (idToken) {
    try {
      const response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`
      );
      const data = await response.json();
      
      // Verify the token is for our app
      if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) {
        console.error("Google token audience mismatch");
        return null;
      }
      
      if (data.email && data.sub) {
        return {
          email: data.email,
          name: data.name || '',
          googleId: data.sub,
          picture: data.picture,
        };
      }
    } catch (err) {
      console.error("ID token verification failed:", err);
    }
  }
  
  // Method 2: Verify access token (fallback)
  if (accessToken) {
    try {
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v2/userinfo`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await response.json();
      
      if (data.email && data.id) {
        return {
          email: data.email,
          name: data.name || '',
          googleId: data.id,
          picture: data.picture,
        };
      }
    } catch (err) {
      console.error("Access token verification failed:", err);
    }
  }
  
  return null;
}

export const googleAuth = async (
  req: Request<{}, {}, GoogleAuthBody>,
  res: Response
) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET!;
    if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined in .env");

    const { idToken, accessToken, email, name, googleId, profilePic } = req.body;

    if (!email || !googleId) {
      return res.status(400).json({ message: "Email and Google ID required" });
    }

    // ✅ SECURITY: Verify Google token if GOOGLE_CLIENT_ID is configured
    if (process.env.GOOGLE_CLIENT_ID) {
      const verifiedUser = await verifyGoogleToken(idToken, accessToken);
      
      if (!verifiedUser) {
        return res.status(401).json({ message: "Invalid Google authentication" });
      }
      
      // Ensure the provided data matches the verified token
      if (verifiedUser.email.toLowerCase() !== email.toLowerCase() || 
          verifiedUser.googleId !== googleId) {
        return res.status(401).json({ message: "Google token mismatch" });
      }
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    let user = await User.findOne({ 
      $or: [
        { email: normalizedEmail },
        { googleId: googleId }
      ]
    });

    if (user) {
      // Update Google ID if not set
      if (!user.googleId) {
        user.googleId = googleId;
        if (profilePic && !user.profilePic) {
          user.profilePic = profilePic;
        }
        await user.save();
      }
      if ((user as any).isDeleted) {
        return res.status(403).json({ message: "Account deleted" });
      }

      // Block unverified business accounts from Google sign-in
      if (user.userType === "business" && !user.isVerified) {
        return res.status(403).json({
          message: "Business account pending admin approval",
          isVerified: false,
          userType: user.userType,
        });
      }
    } else {
      // Create new user with Google data
      const username = normalizedEmail.split('@')[0] + '_' + Date.now().toString(36);
      
      user = new User({
        userType: 'general',
        username,
        email: normalizedEmail,
        password: await bcrypt.hash(googleId + JWT_SECRET, 10), // Secure placeholder password
        name: name || 'User',
        googleId,
        profilePic: profilePic || '',
        phone: '',
        isVerified: true, // Google accounts are pre-verified
      });

      await user.save();

    }

    // Generate token
    const token = jwt.sign(
      {
        _id: user._id,
        username: user.username,
        userType: user.userType,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: user.createdAt ? "Login successful" : "Account created",
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        userType: user.userType,
        name: user.name,
        phone: user.phone,
        isVerified: user.isVerified,
        bio: user.bio,
        profilePic: user.profilePic,
        bannerImg: user.bannerImg,
        location: user.location,
        interests: user.interests,
        companyName: user.companyName,
        requireChatBeforePurchase: user.requireChatBeforePurchase,
        autoReplyEnabled: user.autoReplyEnabled,
        autoReplyMessage: user.autoReplyMessage,
        customQuickQuestion: user.customQuickQuestion,
        inventoryAlertThreshold: user.inventoryAlertThreshold,
        legalAcceptances: user.legalAcceptances,
      },
    });
  } catch (error: any) {
    console.error("GOOGLE AUTH ERROR:", error);
    return res.status(500).json({ message: error.message || "Google auth failed" });
  }
};

/* =======================
   GET PRIVATE DOCUMENT
   (Downloads from R2 - handles both old and new file paths)
======================= */
export const getPrivateDocument = async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    if (!filename) return res.status(400).json({ message: "Filename required" });

    // Decode the URL-encoded filename (e.g. "public%2Fimage.jpg" -> "public/image.jpg")
    const decoded = decodeURIComponent(filename);

    let object: any = null;
    let foundKey: string | null = null;

    // ==========================================
    // STRATEGY 1: Exact & Folder Matches
    // ==========================================
    const paths = [
      decoded,                 // Try as-is
      `public/${decoded}`,     // Try in public/
      `private/${decoded}`     // Try in private/
    ];

    for (const tryKey of paths) {
      try {
        object = await s3.getObject({ Bucket: process.env.CF_BUCKET_NAME!, Key: tryKey }).promise();
        foundKey = tryKey;
        break;
      } catch (err) { /* Continue */ }
    }

    // ==========================================
    // STRATEGY 2: Smart Search (Timestamp Prefix)
    // ==========================================
    // If the request has the timestamp (1769...) but is missing the folder
    if (!object) {
      const prefixMatch = decoded.match(/^(\d+-[0-9.]+)-/);
      if (prefixMatch) {
        const uniquePrefix = prefixMatch[1];

        for (const folder of ["public", "private"]) {
          try {
            const list = await s3.listObjectsV2({
              Bucket: process.env.CF_BUCKET_NAME!,
              Prefix: `${folder}/${uniquePrefix}`,
              MaxKeys: 1
            }).promise();

            if (list.Contents?.[0]?.Key) {
              foundKey = list.Contents[0].Key;
              object = await s3.getObject({ Bucket: process.env.CF_BUCKET_NAME!, Key: foundKey }).promise();
              break;
            }
          } catch (e) { /* Ignore */ }
        }
      }
    }

    // ==========================================
    // STRATEGY 3: Last Resort (Suffix Match)
    // ==========================================
    // If DB has "my-image.jpg" but R2 has "1769...-my-image.jpg"
    if (!object) {
      try {
        // List recent files in public folder (Limit to 100 to avoid performance hit)
        const list = await s3.listObjectsV2({
          Bucket: process.env.CF_BUCKET_NAME!,
          Prefix: "public/",
          MaxKeys: 100 // Adjust if needed
        }).promise();

        const match = list.Contents?.find(item => item.Key?.endsWith(decoded));
        
        if (match && match.Key) {
          foundKey = match.Key;
          object = await s3.getObject({ Bucket: process.env.CF_BUCKET_NAME!, Key: foundKey }).promise();
        }
      } catch (e) {
        // Suffix search failed
      }
    }

    if (!object) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Return the file
    res.setHeader("Content-Type", object.ContentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${foundKey ? foundKey.split('/').pop() : filename}"`);
    res.send(object.Body);

  } catch (error: any) {
    console.error("❌ [GetDoc] Error:", error.message);
    res.status(500).json({ message: "Failed to retrieve document" });
  }
};

/* =======================
   FORGOT PASSWORD - SEND OTP
   Sends OTP to the phone number linked to the account
======================= */
export const forgotPasswordSendOtp = async (req: Request, res: Response) => {
  try {
    const { phone, countryCode = "+91" } = req.body;

    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ message: "Please provide a valid 10-digit phone number" });
    }

    const fullPhone = `${countryCode}${phone}`;

    // Check if a user with this phone exists
    const user = await User.findOne({ phone: fullPhone, isDeleted: { $ne: true } });
    if (!user) {
      // Don't reveal whether the phone exists (security best practice)
      // But for better UX in this app, we tell the user
      return res.status(404).json({ message: "No account found with this phone number" });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Store OTP with purpose "forgot-password"
    otpStore.set(`fp_${fullPhone}`, { otp, expiresAt, verified: false });

    // Clean up after expiry
    setTimeout(() => {
      const stored = otpStore.get(`fp_${fullPhone}`);
      if (stored && stored.expiresAt < Date.now()) {
        otpStore.delete(`fp_${fullPhone}`);
      }
    }, 5 * 60 * 1000);

    // Send OTP via Twilio
    await sendOtpSMS(fullPhone, otp);

    return res.status(200).json({
      message: "OTP sent successfully",
      // Only include test OTP in development
      ...(process.env.NODE_ENV === "development" && { testOtp: otp }),
    });
  } catch (error: any) {
    console.error("Forgot Password Send OTP Error:", error);
    return res.status(500).json({ message: "Failed to send OTP" });
  }
};

/* =======================
   FORGOT PASSWORD - VERIFY OTP
   Verifies the OTP and returns a reset token
======================= */
export const forgotPasswordVerifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, countryCode = "+91", otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: "Phone and OTP are required" });
    }

    const fullPhone = `${countryCode}${phone}`;
    const stored = otpStore.get(`fp_${fullPhone}`);

    if (!stored) {
      return res.status(400).json({ message: "OTP expired or not found. Please request a new one." });
    }

    if (stored.expiresAt < Date.now()) {
      otpStore.delete(`fp_${fullPhone}`);
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP. Please try again." });
    }

    // Mark as verified
    stored.verified = true;
    otpStore.set(`fp_${fullPhone}`, stored);

    // Generate a short-lived reset token (10 minutes)
    const user = await User.findOne({ phone: fullPhone, isDeleted: { $ne: true } });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const resetToken = jwt.sign(
      { _id: user._id, purpose: "password-reset" },
      process.env.JWT_SECRET!,
      { expiresIn: "10m" }
    );

    return res.status(200).json({
      message: "OTP verified successfully",
      verified: true,
      resetToken,
    });
  } catch (error: any) {
    console.error("Forgot Password Verify OTP Error:", error);
    return res.status(500).json({ message: "Failed to verify OTP" });
  }
};

/* =======================
   FORGOT PASSWORD - RESET PASSWORD
   Sets a new password using the reset token
======================= */
export const forgotPasswordReset = async (req: Request, res: Response) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ message: "Reset token and new password are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    // Verify reset token
    let decoded: any;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET!);
    } catch (err) {
      return res.status(400).json({ message: "Reset token expired or invalid. Please start over." });
    }

    if (decoded.purpose !== "password-reset") {
      return res.status(400).json({ message: "Invalid reset token" });
    }

    // Find user and update password
    const user = await User.findById(decoded._id);
    if (!user || user.isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    // Clean up any forgot-password OTPs for this phone
    otpStore.delete(`fp_${user.phone}`);

    return res.status(200).json({ message: "Password reset successfully. You can now sign in." });
  } catch (error: any) {
    console.error("Forgot Password Reset Error:", error);
    return res.status(500).json({ message: "Failed to reset password" });
  }
};
