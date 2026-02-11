import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";
import ImagePost from "../models/ImagePost.js";
import Comment from "../models/Comment.js";
import Follow from "../models/Follow.js";
import PostLike from "../models/PostLike.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  process.env.MONGODB_URI ||
  "";

const BATCH_SIZE = 1000;

const flushBulk = async (ops: any[], model: any, label: string) => {
  if (ops.length === 0) return;
  await model.bulkWrite(ops, { ordered: false });
  console.log(`✅ ${label}: ${ops.length} ops`);
  ops.length = 0;
};

async function migrate() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI/DATABASE_URL/MONGODB_URI");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  // ---- FOLLOWERS/FOLLOWING ----
  const followOps: any[] = [];
  const userCountOps: any[] = [];

  const userCursor = User.collection.find(
    {},
    { projection: { followers: 1, following: 1 } }
  );

  for await (const doc of userCursor as any) {
    const followers = Array.isArray(doc.followers) ? doc.followers : [];
    const following = Array.isArray(doc.following) ? doc.following : [];

    userCountOps.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            followersCount: followers.length,
            followingCount: following.length,
            usernameLower: doc.username ? String(doc.username).toLowerCase() : undefined,
            nameLower: doc.name ? String(doc.name).toLowerCase() : undefined,
            companyNameLower: doc.companyName ? String(doc.companyName).toLowerCase() : undefined,
            emailLower: doc.email ? String(doc.email).toLowerCase() : undefined,
          },
        },
      },
    });

    followers.forEach((followerId: any) => {
      followOps.push({
        updateOne: {
          filter: { follower: followerId, following: doc._id },
          update: { $setOnInsert: { follower: followerId, following: doc._id } },
          upsert: true,
        },
      });
    });

    following.forEach((followingId: any) => {
      followOps.push({
        updateOne: {
          filter: { follower: doc._id, following: followingId },
          update: { $setOnInsert: { follower: doc._id, following: followingId } },
          upsert: true,
        },
      });
    });

    if (userCountOps.length >= BATCH_SIZE) {
      await flushBulk(userCountOps, User, "User counts");
    }
    if (followOps.length >= BATCH_SIZE) {
      await flushBulk(followOps, Follow, "Follow upserts");
    }
  }

  await flushBulk(userCountOps, User, "User counts");
  await flushBulk(followOps, Follow, "Follow upserts");

  // ---- POST LIKES + COUNTS ----
  const likeOps: any[] = [];
  const postCountOps: any[] = [];

  const postCursor = ImagePost.collection.find(
    {},
    { projection: { likedBy: 1 } }
  );

  for await (const doc of postCursor as any) {
    const likedBy = Array.isArray(doc.likedBy) ? doc.likedBy : [];

    postCountOps.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { likesCount: likedBy.length } },
      },
    });

    likedBy.forEach((userId: any) => {
      likeOps.push({
        updateOne: {
          filter: { post: doc._id, user: userId },
          update: { $setOnInsert: { post: doc._id, user: userId } },
          upsert: true,
        },
      });
    });

    if (postCountOps.length >= BATCH_SIZE) {
      await flushBulk(postCountOps, ImagePost, "Post counts");
    }
    if (likeOps.length >= BATCH_SIZE) {
      await flushBulk(likeOps, PostLike, "PostLike upserts");
    }
  }

  await flushBulk(postCountOps, ImagePost, "Post counts");
  await flushBulk(likeOps, PostLike, "PostLike upserts");

  // ---- COMMENTS COUNT ----
  const commentCounts = await Comment.aggregate([
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  const commentOps = commentCounts.map((c: any) => ({
    updateOne: {
      filter: { _id: c._id },
      update: { $set: { commentsCount: c.count } },
    },
  }));
  await flushBulk(commentOps, ImagePost, "Comment counts");

  console.log("Migration complete");
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
