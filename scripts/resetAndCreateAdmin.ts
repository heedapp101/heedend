/**
 * ⚠️ DANGER: This script will DELETE ALL DATA and create a fresh admin account
 * 
 * Usage: npx tsx scripts/resetAndCreateAdmin.ts
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

// Admin credentials
const ADMIN_USERNAME = "paulheedgo@123";
const ADMIN_PASSWORD = "pokemongokalikka@123";
const ADMIN_EMAIL = "admin@heed.app";
const ADMIN_NAME = "HEED Admin";
const ADMIN_PHONE = "0000000000";

async function resetAndCreateAdmin() {
  try {
    console.log("🔵 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI!);
    console.log("✅ Connected to MongoDB");

    // Get all collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    
    console.log("\n⚠️  WARNING: About to delete ALL data from these collections:");
    collections.forEach(col => console.log(`   - ${col.name}`));
    
    // Drop all collections
    console.log("\n🗑️  Dropping all collections...");
    for (const collection of collections) {
      await mongoose.connection.db.dropCollection(collection.name);
      console.log(`   ✓ Dropped: ${collection.name}`);
    }
    console.log("✅ All collections dropped");

    // Create User model inline (to avoid import issues)
    const userSchema = new mongoose.Schema({
      userType: { type: String, enum: ["general", "business", "admin"], required: true },
      username: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      password: { type: String, required: true },
      phone: { type: String, required: true },
      isVerified: { type: Boolean, default: true },
      bio: String,
      profilePic: String,
      bannerImg: String,
      location: String,
      interests: [{ tag: String, score: Number, lastInteracted: Date }],
      followers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      following: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      pushTokens: [{ token: String, platform: String, addedAt: Date }],
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    });

    const User = mongoose.model("User", userSchema);

    // Hash password
    console.log("\n🔐 Creating admin account...");
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, salt);

    // Create admin user
    const adminUser = new User({
      userType: "admin",
      username: ADMIN_USERNAME.toLowerCase().trim(),
      name: ADMIN_NAME,
      email: ADMIN_EMAIL.toLowerCase().trim(),
      password: hashedPassword,
      phone: ADMIN_PHONE,
      isVerified: true,
    });

    await adminUser.save();

    console.log("✅ Admin account created successfully!\n");
    console.log("╔════════════════════════════════════════════╗");
    console.log("║         ADMIN CREDENTIALS                  ║");
    console.log("╠════════════════════════════════════════════╣");
    console.log(`║  Username: ${ADMIN_USERNAME.padEnd(30)}║`);
    console.log(`║  Password: ${ADMIN_PASSWORD.padEnd(30)}║`);
    console.log(`║  Email:    ${ADMIN_EMAIL.padEnd(30)}║`);
    console.log("╚════════════════════════════════════════════╝");
    console.log("\n🎉 Database reset complete!");

  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n👋 Disconnected from MongoDB");
    process.exit(0);
  }
}

resetAndCreateAdmin();
