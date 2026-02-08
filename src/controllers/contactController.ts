import { Request, Response } from "express";
import { logError } from "../utils/emailService.js";

interface ContactMessage {
  name: string;
  email: string;
  message: string;
  timestamp: Date;
}

// Store messages (in production, save to MongoDB)
const contactMessages: ContactMessage[] = [];

/**
 * POST /api/contact
 * Receive contact form submissions from landing page
 */
export const submitContactForm = async (req: Request, res: Response) => {
  try {
    const { name, email, message } = req.body;

    // Validation
    if (!name || !email || !message) {
      return res.status(400).json({ 
        success: false, 
        message: "Name, email, and message are required" 
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        message: "Please provide a valid email address" 
      });
    }

    // Store the message
    const contactMessage: ContactMessage = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      message: message.trim(),
      timestamp: new Date(),
    };
    contactMessages.push(contactMessage);

    // Log for admin notification (using existing email service)
    console.log("📧 New contact form submission:", {
      name: contactMessage.name,
      email: contactMessage.email,
      messagePreview: contactMessage.message.substring(0, 100),
    });

    // Optional: Send notification email to admin
    try {
      await logError({
        message: `New Contact Form Submission from ${contactMessage.name}`,
        source: "api",
        severity: "low",
        errorCode: "CONTACT_SUBMISSION",
        stack: `Name: ${contactMessage.name}\nEmail: ${contactMessage.email}\nMessage: ${contactMessage.message}`,
      });
    } catch (emailErr) {
      // Don't fail the request if email notification fails
      console.warn("Failed to send contact notification email:", emailErr);
    }

    return res.status(200).json({
      success: true,
      message: "Thank you for your message! We'll get back to you soon.",
    });

  } catch (error) {
    console.error("Contact form error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit message. Please try again.",
    });
  }
};

/**
 * GET /api/contact/messages (Admin only)
 * Retrieve all contact form messages
 */
export const getContactMessages = async (req: Request, res: Response) => {
  try {
    // In production, add admin authentication middleware
    return res.status(200).json({
      success: true,
      messages: contactMessages.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    });
  } catch (error) {
    console.error("Get messages error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve messages.",
    });
  }
};
