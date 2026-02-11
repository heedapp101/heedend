import { Request, Response } from "express";
import ImagePost from "../models/ImagePost.js";
import User from "../models/User.js";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildSearchPatterns = (value: string) => {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];

  const tokens = normalized.split(" ").filter(Boolean);
  const patternSet = new Set<string>();
  const addPattern = (pattern: string) => {
    const p = pattern.trim();
    if (p.length >= 2) patternSet.add(p);
  };

  tokens.forEach((token) => {
    addPattern(token);
    if (token.length >= 4) addPattern(token.slice(0, 3));
    if (token.length >= 5) addPattern(token.slice(0, 4));
  });

  if (tokens.length === 1) {
    const token = tokens[0];
    const mid = Math.floor(token.length / 2);
    for (let offset = -2; offset <= 2; offset++) {
      const splitAt = mid + offset;
      if (splitAt < 3 || token.length - splitAt < 3) continue;
      const left = token.slice(0, splitAt);
      const right = token.slice(splitAt);
      addPattern(left);
      addPattern(right);
      if (right.length >= 4) addPattern(right.slice(0, 3));
    }
  }

  return Array.from(patternSet).slice(0, 12);
};

const buildQueryRegexes = (value: string) =>
  buildSearchPatterns(value).map((pattern) => new RegExp(escapeRegex(pattern), "i"));

/**
 * Unified Search Controller
 * MongoDB text index + regex fallback
 */
export const searchAll = async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.q || "").trim();
    if (!raw) return res.json({ users: [], posts: [], tags: [], similar: [] });

    const mode = raw.startsWith("@") ? "users" : raw.startsWith("#") ? "tags" : "all";
    const query = raw.replace(/^[@#]/, "").trim();
    if (!query) return res.json({ users: [], posts: [], tags: [], similar: [] });

    // MongoDB search (text index + regex fallbacks)

    const usersLimit = clamp(parseInt(req.query.usersLimit as string) || 8, 0, 20);
    const postsLimit = clamp(parseInt(req.query.postsLimit as string) || 20, 0, 50);
    const tagsLimit = clamp(parseInt(req.query.tagsLimit as string) || 10, 0, 20);
    const page = clamp(parseInt(req.query.page as string) || 1, 1, 1000);
    const skip = (page - 1) * postsLimit;

    const escaped = escapeRegex(query);
    const prefixRegex = new RegExp(`^${escaped}`, "i");
    const containsRegex = new RegExp(escaped, "i");
    const fuzzyRegexes = buildQueryRegexes(query);
    const tagMatchConditions = (
      fuzzyRegexes.length > 0 ? fuzzyRegexes : [containsRegex]
    ).map((regex) => ({ tags: { $regex: regex } }));

    const basePostFilter = {
      $and: [
        { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] },
        { $or: [{ adminHidden: false }, { adminHidden: { $exists: false } }] },
      ],
    };

    const searchUsers = async () => {
      if (usersLimit === 0) return [];

      const selectFields =
        "_id username name userType profilePic isVerified companyName email followers";

      const selectObj: Record<string, any> = {
        _id: 1, username: 1, name: 1, userType: 1, profilePic: 1,
        isVerified: 1, companyName: 1, email: 1, followers: 1,
      };

      const baseUserFilter = { userType: { $ne: "admin" }, isDeleted: { $ne: true } };

      // Build word-boundary regexes for individual words in multi-word queries
      const queryWords = query.split(/\s+/).filter(Boolean).map(w => escapeRegex(w));
      const wordRegexes = queryWords.map(w => new RegExp(w, "i"));

      // 1. Prefix regex search (most reliable — run first)
      const prefixUsers = await User.find({
        ...baseUserFilter,
        $or: [
          { username: { $regex: prefixRegex } },
          { name: { $regex: prefixRegex } },
          { companyName: { $regex: prefixRegex } },
          { email: { $regex: prefixRegex } },
          // Also match individual words against name parts
          ...wordRegexes.map(wr => ({ name: { $regex: wr } })),
          ...wordRegexes.map(wr => ({ username: { $regex: wr } })),
        ],
      })
        .select(selectFields)
        .limit(usersLimit * 3)
        .lean();

      // 2. Try full-text search for additional results (uses weighted text index)
      const prefixIds = prefixUsers.map((u: any) => u._id);
      let textUsers: any[] = [];
      try {
        textUsers = await User.find(
          { $text: { $search: query }, _id: { $nin: prefixIds }, ...baseUserFilter }
        )
          .select({ ...selectObj, textScore: { $meta: "textScore" } })
          .sort({ textScore: { $meta: "textScore" } })
          .limit(usersLimit * 2)
          .lean();
      } catch {
        textUsers = [];
      }

      // 3. Contains regex search (catch remaining matches)
      const combinedIds = [...prefixIds, ...textUsers.map((u: any) => u._id)];
      const containsUsers = await User.find({
        _id: { $nin: combinedIds },
        ...baseUserFilter,
        $or: [
          { username: { $regex: containsRegex } },
          { name: { $regex: containsRegex } },
          { companyName: { $regex: containsRegex } },
          { email: { $regex: containsRegex } },
        ],
      })
        .select(selectFields)
        .limit(usersLimit)
        .lean();

      // Deduplicate by _id
      const seenIds = new Set<string>();
      const allUsers = [...prefixUsers, ...textUsers, ...containsUsers]
        .filter((u: any) => u?.userType !== "admin")
        .filter((u: any) => {
        const id = String(u._id);
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });

      const norm = query.toLowerCase();
      const normWords = norm.split(/\s+/).filter(Boolean);
      const scored = allUsers.map((u: any) => {
        const username = String(u.username || "").toLowerCase();
        const name = String(u.name || "").toLowerCase();
        const company = String(u.companyName || "").toLowerCase();
        const followersCount = Array.isArray(u.followers) ? u.followers.length : 0;

        // Split name into individual words for word-level matching
        const nameWords = name.split(/\s+/).filter(Boolean);
        const companyWords = company.split(/\s+/).filter(Boolean);

        let score = 0;
        if (username === norm) score += 100;
        if (username.startsWith(norm)) score += 60;
        if (name === norm) score += 50;
        if (name.startsWith(norm)) score += 30;
        if (company.startsWith(norm)) score += 25;
        if (username.includes(norm)) score += 20;
        if (name.includes(norm)) score += 10;

        // Word-level matching: boost if query matches any word in name exactly
        if (nameWords.some(w => w === norm)) score += 40;
        if (companyWords.some(w => w === norm)) score += 35;
        // Boost if every query word matches a name word
        if (normWords.length > 1 && normWords.every(qw => nameWords.some(nw => nw.startsWith(qw)))) score += 45;
        if (company.includes(norm)) score += 10;
        if (u.isVerified) score += 5;
        score += Math.min(10, followersCount / 100);

        return {
          ...u,
          followersCount,
          _score: score,
        };
      });

      scored.sort((a: any, b: any) => {
        if (b._score !== a._score) return b._score - a._score;
        if (b.followersCount !== a.followersCount)
          return b.followersCount - a.followersCount;
        return String(a.username || "").localeCompare(String(b.username || ""));
      });

      return scored.slice(0, usersLimit).map(({ _score, followers, ...rest }: any) => rest);
    };

    const searchTags = async () => {
      if (tagsLimit === 0) return [];

      const tagResults = await ImagePost.aggregate([
        {
          $match: {
            $and: [
              basePostFilter,
              { $or: tagMatchConditions },
            ],
          },
        },
        { $unwind: "$tags" },
        { $match: { $or: tagMatchConditions } },
        { $group: { _id: "$tags", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: tagsLimit },
        { $project: { _id: 0, tag: "$_id", count: 1 } },
      ]);

      return tagResults;
    };

    const searchPosts = async () => {
      if (postsLimit === 0) return [];

      let posts: any[] = [];

      if (mode === "tags") {
        posts = await ImagePost.find({
          $and: [
            basePostFilter,
            { $or: tagMatchConditions },
          ],
        })
          .populate("user", "username userType profilePic name companyName isVerified")
          .sort({ views: -1, createdAt: -1 })
          .skip(skip)
          .limit(postsLimit)
          .lean();
      } else {
        // 1. Full-text search (title, description, tags weighted)
        try {
          posts = await ImagePost.find(
            { $and: [basePostFilter, { $text: { $search: query } }] },
            { score: { $meta: "textScore" } }
          )
            .populate("user", "username userType profilePic name companyName isVerified")
            .sort({ score: { $meta: "textScore" }, views: -1 })
            .skip(skip)
            .limit(postsLimit)
            .lean();
        } catch {
          posts = [];
        }

        // 2. Regex fallback if text search returned nothing
        if (posts.length === 0) {
          const regexConditions =
            fuzzyRegexes.length > 0
              ? fuzzyRegexes.flatMap((regex) => [
                  { title: { $regex: regex } },
                  { description: { $regex: regex } },
                  { tags: { $regex: regex } },
                ])
              : [
                  { title: { $regex: containsRegex } },
                  { description: { $regex: containsRegex } },
                  { tags: { $regex: containsRegex } },
                ];

          posts = await ImagePost.find({
            $and: [
              basePostFilter,
              {
                $or: regexConditions,
              },
            ],
          })
            .populate("user", "username userType profilePic name companyName isVerified")
            .sort({ views: -1, createdAt: -1 })
            .skip(skip)
            .limit(postsLimit)
            .lean();
        }

        // 3. Smart tag expansion — if results are sparse, find posts via matching tags
        if (posts.length < postsLimit) {
          const existingIds = posts.map((p: any) => p._id);
          const remaining = postsLimit - posts.length;

          // Find all tags that match the query
          const matchingTags = await ImagePost.distinct("tags", {
            $and: [
              basePostFilter,
              { $or: tagMatchConditions },
            ],
          });

          if (matchingTags.length > 0) {
            const tagPosts = await ImagePost.find({
              ...basePostFilter,
              _id: { $nin: existingIds },
              tags: { $in: matchingTags },
            })
              .populate("user", "username userType profilePic name companyName isVerified")
              .sort({ views: -1, createdAt: -1 })
              .limit(remaining)
              .lean();

            posts = [...posts, ...tagPosts];
          }
        }
      }

      return posts.map((post) => ({
        ...post,
        likes: (post as any).likedBy?.length || 0,
      }));
    };

    // Smart similar: gather posts that share tags with matched posts
    const findSimilarByTags = async (matchedPosts: any[], matchedPostIds: string[]) => {
      if (matchedPosts.length === 0) return [];
      // Collect all tags from matched posts
      const allTags = [...new Set(matchedPosts.flatMap((p: any) => p.tags || []))];
      if (allTags.length === 0) return [];

      const similar = await ImagePost.find({
        ...basePostFilter,
        _id: { $nin: matchedPostIds },
        tags: { $in: allTags },
      })
        .populate("user", "username userType profilePic name companyName isVerified")
        .sort({ views: -1, createdAt: -1 })
        .limit(10)
        .lean();

      return similar.map((post) => ({
        ...post,
        likes: (post as any).likedBy?.length || 0,
      }));
    };

    const [users, posts, tags] = await Promise.all([
      mode === "tags" ? Promise.resolve([]) : searchUsers(),
      mode === "users" ? Promise.resolve([]) : searchPosts(),
      mode === "users" ? Promise.resolve([]) : searchTags(),
    ]);

    // Find similar items based on tags from matched posts
    const postIds = posts.map((p: any) => String(p._id));
    const similar = mode === "users" ? [] : await findSimilarByTags(posts, postIds);

    res.json({ users, posts, tags, similar });
  } catch (err) {
    console.error("Search Error:", err);
    res.status(500).json({ message: "Failed to search" });
  }
};
