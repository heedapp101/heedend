// src/services/typesenseSearch.ts
/**
 * Typesense Search Service
 * 
 * High-performance search with:
 * - Typo tolerance
 * - Relevance ranking
 * - Faceted filtering
 * - ~5ms response times
 */

import { getTypesenseClient, isTypesenseAvailable } from "../config/typesense.js";
import { SearchParams } from "typesense/lib/Typesense/Documents.js";

// ==========================================
// SEARCH INTERFACES
// ==========================================

export interface SearchOptions {
  query: string;
  page?: number;
  limit?: number;
  filters?: string;
  sortBy?: string;
}

export interface PostSearchResult {
  id: string;
  title: string;
  description: string;
  tags: string[];
  price: number;
  views: number;
  likes: number;
  userId: string;
  username: string;
  userType: string;
  profilePic: string;
  companyName: string;
  isVerified: boolean;
  imageUrl: string;
  imageUrlHigh: string;
  isBoosted: boolean;
  createdAt: number;
  _score?: number;
}

export interface UserSearchResult {
  id: string;
  username: string;
  name: string;
  userType: string;
  companyName: string;
  profilePic: string;
  isVerified: boolean;
  followersCount: number;
  location: string;
  _score?: number;
}

export interface TagSearchResult {
  tag: string;
  count: number;
}

export interface SearchResponse<T> {
  hits: T[];
  found: number;
  page: number;
  totalPages: number;
  searchTimeMs: number;
}

// ==========================================
// SEARCH FUNCTIONS
// ==========================================

/**
 * Search posts with typo tolerance and relevance ranking
 */
export const searchPosts = async (
  options: SearchOptions
): Promise<SearchResponse<PostSearchResult>> => {
  const client = getTypesenseClient();
  
  const { query, page = 1, limit = 20, filters, sortBy } = options;
  
  // Build search parameters
  const searchParams: SearchParams = {
    q: query,
    query_by: "title,tags,description,username,companyName",
    query_by_weights: "10,8,3,2,2", // Title most important, then tags
    prefix: "true,true,false,true,true", // Enable prefix search for titles/tags/usernames
    num_typos: "2,1,1,1,1", // More typo tolerance for title
    typo_tokens_threshold: 1,
    per_page: limit,
    page: page,
    highlight_full_fields: "title,tags",
    highlight_start_tag: "<mark>",
    highlight_end_tag: "</mark>",
    filter_by: filters || "isArchived:false",
    sort_by: sortBy || "_text_match:desc,views:desc,createdAt:desc",
    exhaustive_search: false, // Faster but might miss some results
    prioritize_exact_match: true,
    prioritize_token_position: true,
  };
  
  try {
    const result = await client.collections("posts").documents().search(searchParams);
    
    const hits: PostSearchResult[] = (result.hits || []).map((hit: any) => ({
      ...hit.document,
      _score: hit.text_match_info?.score || 0,
      // Include highlights for UI
      _highlights: hit.highlights,
    }));
    
    return {
      hits,
      found: result.found || 0,
      page,
      totalPages: Math.ceil((result.found || 0) / limit),
      searchTimeMs: result.search_time_ms || 0,
    };
  } catch (error) {
    console.error("Typesense post search error:", error);
    throw error;
  }
};

/**
 * Search users with typo tolerance
 */
export const searchUsers = async (
  options: SearchOptions
): Promise<SearchResponse<UserSearchResult>> => {
  const client = getTypesenseClient();
  
  const { query, page = 1, limit = 10, filters } = options;
  
  const searchParams: SearchParams = {
    q: query,
    query_by: "username,name,companyName,bio",
    query_by_weights: "10,8,6,2",
    prefix: "true,true,true,false",
    num_typos: "2,2,1,1",
    per_page: limit,
    page: page,
    filter_by: filters || "userType:!=[admin]",
    sort_by: "_text_match:desc,followersCount:desc",
    prioritize_exact_match: true,
  };
  
  try {
    const result = await client.collections("users").documents().search(searchParams);
    
    const hits: UserSearchResult[] = (result.hits || []).map((hit: any) => ({
      ...hit.document,
      _score: hit.text_match_info?.score || 0,
    }));
    
    return {
      hits,
      found: result.found || 0,
      page,
      totalPages: Math.ceil((result.found || 0) / limit),
      searchTimeMs: result.search_time_ms || 0,
    };
  } catch (error) {
    console.error("Typesense user search error:", error);
    throw error;
  }
};

/**
 * Search/autocomplete tags
 */
export const searchTags = async (
  query: string,
  limit: number = 10
): Promise<TagSearchResult[]> => {
  const client = getTypesenseClient();
  
  const searchParams: SearchParams = {
    q: query,
    query_by: "tag",
    prefix: "true",
    num_typos: "1",
    per_page: limit,
    sort_by: "count:desc",
  };
  
  try {
    const result = await client.collections("tags").documents().search(searchParams);
    
    return (result.hits || []).map((hit: any) => ({
      tag: hit.document.tag,
      count: hit.document.count,
    }));
  } catch (error) {
    console.error("Typesense tag search error:", error);
    return [];
  }
};

/**
 * Multi-search: Search posts, users, and tags in parallel
 */
export const searchAll = async (options: {
  query: string;
  postsLimit?: number;
  usersLimit?: number;
  tagsLimit?: number;
  page?: number;
}): Promise<{
  posts: SearchResponse<PostSearchResult>;
  users: SearchResponse<UserSearchResult>;
  tags: TagSearchResult[];
  searchTimeMs: number;
}> => {
  const { query, postsLimit = 20, usersLimit = 8, tagsLimit = 10, page = 1 } = options;
  const startTime = Date.now();
  
  // Parallel search
  const [posts, users, tags] = await Promise.all([
    searchPosts({ query, page, limit: postsLimit }),
    searchUsers({ query, limit: usersLimit }),
    searchTags(query, tagsLimit),
  ]);
  
  return {
    posts,
    users,
    tags,
    searchTimeMs: Date.now() - startTime,
  };
};

/**
 * Get posts by specific tags (for tag search mode)
 */
export const searchPostsByTags = async (
  tags: string[],
  options: { page?: number; limit?: number } = {}
): Promise<SearchResponse<PostSearchResult>> => {
  const client = getTypesenseClient();
  const { page = 1, limit = 20 } = options;
  
  // Build filter for tags
  const tagFilter = tags.map((t) => `tags:=${t}`).join(" || ");
  
  const searchParams: SearchParams = {
    q: "*", // Match all
    query_by: "title",
    filter_by: `(${tagFilter}) && isArchived:false`,
    per_page: limit,
    page: page,
    sort_by: "views:desc,createdAt:desc",
  };
  
  try {
    const result = await client.collections("posts").documents().search(searchParams);
    
    const hits: PostSearchResult[] = (result.hits || []).map((hit: any) => hit.document);
    
    return {
      hits,
      found: result.found || 0,
      page,
      totalPages: Math.ceil((result.found || 0) / limit),
      searchTimeMs: result.search_time_ms || 0,
    };
  } catch (error) {
    console.error("Typesense tag search error:", error);
    throw error;
  }
};

/**
 * Get similar posts based on tags (for recommendations)
 */
export const findSimilarPosts = async (
  tags: string[],
  excludePostId: string,
  limit: number = 10
): Promise<PostSearchResult[]> => {
  const client = getTypesenseClient();
  
  if (tags.length === 0) return [];
  
  // Build filter for tags
  const tagFilter = tags.map((t) => `tags:=${t}`).join(" || ");
  
  const searchParams: SearchParams = {
    q: "*",
    query_by: "title",
    filter_by: `(${tagFilter}) && isArchived:false && id:!=${excludePostId}`,
    per_page: limit,
    sort_by: "views:desc",
  };
  
  try {
    const result = await client.collections("posts").documents().search(searchParams);
    return (result.hits || []).map((hit: any) => hit.document);
  } catch (error) {
    console.error("Typesense similar search error:", error);
    return [];
  }
};

/**
 * Faceted search for explore page
 */
export const explorePosts = async (options: {
  page?: number;
  limit?: number;
  userType?: string;
  priceMin?: number;
  priceMax?: number;
  tags?: string[];
  sortBy?: "trending" | "recent" | "popular";
}): Promise<SearchResponse<PostSearchResult> & { facets: any }> => {
  const client = getTypesenseClient();
  
  const {
    page = 1,
    limit = 20,
    userType,
    priceMin,
    priceMax,
    tags,
    sortBy = "trending",
  } = options;
  
  // Build filters
  const filters: string[] = ["isArchived:false"];
  
  if (userType) filters.push(`userType:=${userType}`);
  if (priceMin !== undefined) filters.push(`price:>=${priceMin}`);
  if (priceMax !== undefined) filters.push(`price:<=${priceMax}`);
  if (tags && tags.length > 0) {
    filters.push(`(${tags.map((t) => `tags:=${t}`).join(" || ")})`);
  }
  
  // Sort options
  const sortOptions: Record<string, string> = {
    trending: "isBoosted:desc,views:desc,likes:desc,createdAt:desc",
    recent: "createdAt:desc",
    popular: "views:desc,likes:desc",
  };
  
  const searchParams: SearchParams = {
    q: "*",
    query_by: "title",
    filter_by: filters.join(" && "),
    per_page: limit,
    page: page,
    sort_by: sortOptions[sortBy] || sortOptions.trending,
    facet_by: "tags,userType,isVerified",
    max_facet_values: 20,
  };
  
  try {
    const result = await client.collections("posts").documents().search(searchParams);
    
    const hits: PostSearchResult[] = (result.hits || []).map((hit: any) => hit.document);
    
    return {
      hits,
      found: result.found || 0,
      page,
      totalPages: Math.ceil((result.found || 0) / limit),
      searchTimeMs: result.search_time_ms || 0,
      facets: result.facet_counts || [],
    };
  } catch (error) {
    console.error("Typesense explore error:", error);
    throw error;
  }
};

export default {
  searchPosts,
  searchUsers,
  searchTags,
  searchAll,
  searchPostsByTags,
  findSimilarPosts,
  explorePosts,
  isTypesenseAvailable,
};
