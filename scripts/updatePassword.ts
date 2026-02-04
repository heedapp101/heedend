import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

async function updatePassword() {
  await mongoose.connect(process.env.MONGO_URI!);
  
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash("indpjjuryhdeem@4499", salt);
  
  const result = await mongoose.connection.db.collection("users").updateOne(
    { username: "paulheedgo@123" },
    { $set: { password: hash } }
  );
  
  if (result.modifiedCount > 0) {
    console.log("✅ Password updated successfully!");
  } else {
    console.log("❌ User not found or password unchanged");
  }
  
  await mongoose.disconnect();
}

updatePassword();
