import { Response, NextFunction } from "express";
import { AuthRequest } from "./authMiddleware.js"; // or types.ts

export const requireBusiness = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (req.user.userType !== "business") {
    return res.status(403).json({ message: "Access denied" });
  }

  next();
};

export const adminMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (req.user.userType !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
};

// Generic role checker
export const requireRole = (role: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (req.user.userType !== role) {
      return res.status(403).json({ message: `${role} access required` });
    }

    next();
  };
};
