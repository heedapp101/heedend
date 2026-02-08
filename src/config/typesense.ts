// src/config/typesense.ts
/**
 * Typesense Configuration
 * 
 * Fast, typo-tolerant search engine for posts and users.
 * ~5ms response time vs MongoDB's ~50-200ms
 * 
 * Setup options:
 * 1. Typesense Cloud: https://cloud.typesense.org (easiest)
 * 2. Self-hosted: Docker on Railway/Fly.io
 * 
 * Required env vars:
 * - TYPESENSE_HOST (e.g., 'xxx.typesense.net' or 'localhost')
 * - TYPESENSE_PORT (default: 443 for cloud, 8108 for local)
 * - TYPESENSE_PROTOCOL (default: 'https' for cloud, 'http' for local)
 * - TYPESENSE_API_KEY (admin API key)
 */

import Typesense from "typesense";
import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.js";

// ==========================================
// CLIENT CONFIGURATION
// ==========================================

const typesenseConfig = {
  nodes: [
    {
      host: process.env.TYPESENSE_HOST || "localhost",
      port: parseInt(process.env.TYPESENSE_PORT || "8108"),
      protocol: process.env.TYPESENSE_PROTOCOL || "http",
    },
  ],
  apiKey: process.env.TYPESENSE_API_KEY || "xyz", // Admin API key
  connectionTimeoutSeconds: 5,
  retryIntervalSeconds: 0.1,
  numRetries: 3,
};

// Singleton client instance
let typesenseClient: Typesense.Client | null = null;

/**
 * Get the Typesense client instance
 */
export const getTypesenseClient = (): Typesense.Client => {
  if (!typesenseClient) {
    typesenseClient = new Typesense.Client(typesenseConfig);
  }
  return typesenseClient;
};

/**
 * Check if Typesense is available and configured
 */
export const isTypesenseAvailable = async (): Promise<boolean> => {
  if (!process.env.TYPESENSE_API_KEY || !process.env.TYPESENSE_HOST) {
    console.warn("⚠️ Typesense not configured - falling back to MongoDB search");
    return false;
  }
  
  try {
    const client = getTypesenseClient();
    await client.health.retrieve();
    return true;
  } catch (error) {
    console.warn("⚠️ Typesense not available:", (error as Error).message);
    return false;
  }
};

// ==========================================
// COLLECTION SCHEMAS
// ==========================================

/**
 * Posts collection schema
 * Optimized for product/image post search
 */
export const postsCollectionSchema: CollectionCreateSchema = {
  name: "posts",
  fields: [
    { name: "id", type: "string" }, // MongoDB _id
    { name: "title", type: "string" },
    { name: "description", type: "string" },
    { name: "tags", type: "string[]", facet: true },
    { name: "price", type: "float", optional: true, facet: true },
    { name: "views", type: "int32", facet: true },
    { name: "likes", type: "int32", facet: true },
    { name: "userId", type: "string", facet: true },
    { name: "username", type: "string" },
    { name: "userType", type: "string", facet: true },
    { name: "profilePic", type: "string", optional: true },
    { name: "companyName", type: "string", optional: true },
    { name: "isVerified", type: "bool", facet: true },
    { name: "imageUrl", type: "string" }, // First image (low res for preview)
    { name: "imageUrlHigh", type: "string" }, // High res
    { name: "isBoosted", type: "bool", facet: true },
    { name: "isArchived", type: "bool", facet: true },
    { name: "createdAt", type: "int64" }, // Unix timestamp for sorting
  ],
  default_sorting_field: "createdAt",
  token_separators: ["-", "_"], // Handle hyphenated words
  symbols_to_index: ["#", "@"], // Index hashtags and mentions
};

/**
 * Users collection schema
 * Optimized for user/seller search
 */
export const usersCollectionSchema: CollectionCreateSchema = {
  name: "users",
  fields: [
    { name: "id", type: "string" }, // MongoDB _id
    { name: "username", type: "string" },
    { name: "name", type: "string" },
    { name: "email", type: "string" },
    { name: "userType", type: "string", facet: true },
    { name: "companyName", type: "string", optional: true },
    { name: "bio", type: "string", optional: true },
    { name: "profilePic", type: "string", optional: true },
    { name: "location", type: "string", optional: true, facet: true },
    { name: "isVerified", type: "bool", facet: true },
    { name: "followersCount", type: "int32", facet: true },
    { name: "followingCount", type: "int32" },
    { name: "productType", type: "string", optional: true, facet: true },
    { name: "createdAt", type: "int64" },
  ],
  default_sorting_field: "followersCount",
};

/**
 * Tags collection schema (for autocomplete)
 */
export const tagsCollectionSchema: CollectionCreateSchema = {
  name: "tags",
  fields: [
    { name: "id", type: "string" },
    { name: "tag", type: "string" },
    { name: "count", type: "int32" },
  ],
  default_sorting_field: "count",
};

// ==========================================
// COLLECTION INITIALIZATION
// ==========================================

/**
 * Initialize all Typesense collections
 * Run on server startup or via admin endpoint
 */
export const initializeTypesenseCollections = async (): Promise<void> => {
  const client = getTypesenseClient();
  
  const collections = [
    { schema: postsCollectionSchema, name: "posts" },
    { schema: usersCollectionSchema, name: "users" },
    { schema: tagsCollectionSchema, name: "tags" },
  ];
  
  for (const { schema, name } of collections) {
    try {
      // Check if collection exists
      await client.collections(name).retrieve();
      console.log(`✅ Typesense collection '${name}' exists`);
    } catch (error: any) {
      if (error.httpStatus === 404) {
        // Create collection
        await client.collections().create(schema);
        console.log(`✅ Created Typesense collection '${name}'`);
      } else {
        console.error(`❌ Error with collection '${name}':`, error.message);
        throw error;
      }
    }
  }
};

/**
 * Drop and recreate a collection (for schema changes)
 */
export const recreateCollection = async (
  collectionName: string,
  schema: CollectionCreateSchema
): Promise<void> => {
  const client = getTypesenseClient();
  
  try {
    await client.collections(collectionName).delete();
    console.log(`🗑️ Deleted collection '${collectionName}'`);
  } catch {
    // Collection doesn't exist, that's fine
  }
  
  await client.collections().create(schema);
  console.log(`✅ Recreated collection '${collectionName}'`);
};

export default {
  getTypesenseClient,
  isTypesenseAvailable,
  initializeTypesenseCollections,
  recreateCollection,
  postsCollectionSchema,
  usersCollectionSchema,
  tagsCollectionSchema,
};
