import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import User from "../models/User.js";

export interface AuthRequest extends Request {
  user?: {
    _id: Types.ObjectId;
    username?: string;
    name?: string;
    userType?: string;
    email?: string;
  };
}

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET!;
    if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined in .env");

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Unauthorized: No token" });
    }

    const token = authHeader.split(" ")[1]; // Bearer <token>
    if (!token) {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    if (!decoded || !decoded._id) {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    // Ensure user exists and is not deleted
    const userRecord = await User.findById(decoded._id)
      .select("_id username name userType email isDeleted");
    if (!userRecord || userRecord.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    (req as AuthRequest).user = {
      _id: new Types.ObjectId(userRecord._id),
      username: userRecord.username,
      name: userRecord.name,
      userType: userRecord.userType,
      email: userRecord.email,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ message: "Unauthorized" });
  }
};

/**
 * Optional Auth - Attaches user if token exists, but doesn't require it
 * Useful for endpoints that work for both authenticated and anonymous users
 */
export const optionalAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const JWT_SECRET = process.env.JWT_SECRET!;
    if (!JWT_SECRET) {
      return next(); // Continue without auth
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return next(); // No token, continue as anonymous
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return next(); // Invalid format, continue as anonymous
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    if (decoded && decoded._id) {
      // Attach user only if not deleted
      User.findById(decoded._id)
        .select("_id username name userType email isDeleted")
        .then((userRecord) => {
          if (!userRecord || userRecord.isDeleted) return;
          (req as AuthRequest).user = {
            _id: new Types.ObjectId(userRecord._id),
            username: userRecord.username,
            name: userRecord.name,
            userType: userRecord.userType,
            email: userRecord.email,
          };
        })
        .finally(() => next());
      return;
    }

    next();
  } catch (err) {
    // Token invalid/expired - continue as anonymous
    next();
  }
};
