import { getRedisCommandClient } from "../config/redis.js";

const fallbackPresence = new Map<string, Set<string>>();

const getPresenceKey = (userId: string) => `presence:user:${userId}`;

const getRedisClientSafe = async () => {
  try {
    return await getRedisCommandClient();
  } catch (error) {
    console.warn("Redis unavailable for presence store, using in-memory fallback.", error);
    return null;
  }
};

export const markUserOnline = async (userId: string, socketId: string): Promise<boolean> => {
  const client = await getRedisClientSafe();
  if (client) {
    await client.sAdd(getPresenceKey(userId), socketId);
    const count = await client.sCard(getPresenceKey(userId));
    return count === 1;
  }

  const sockets = fallbackPresence.get(userId) || new Set<string>();
  const wasEmpty = sockets.size === 0;
  sockets.add(socketId);
  fallbackPresence.set(userId, sockets);
  return wasEmpty;
};

export const markUserOffline = async (userId: string, socketId: string): Promise<boolean> => {
  const client = await getRedisClientSafe();
  if (client) {
    await client.sRem(getPresenceKey(userId), socketId);
    const count = await client.sCard(getPresenceKey(userId));
    return count === 0;
  }

  const sockets = fallbackPresence.get(userId);
  if (!sockets) return true;
  sockets.delete(socketId);
  if (sockets.size === 0) {
    fallbackPresence.delete(userId);
    return true;
  }
  return false;
};

export const isUserOnline = async (userId: string): Promise<boolean> => {
  const client = await getRedisClientSafe();
  if (client) {
    const count = await client.sCard(getPresenceKey(userId));
    return count > 0;
  }

  return (fallbackPresence.get(userId)?.size || 0) > 0;
};
