import { createClient, RedisClientType } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let commandClient: RedisClientType | null = null;
let pubClient: RedisClientType | null = null;
let subClient: RedisClientType | null = null;

const attachErrorLogger = (client: RedisClientType, label: string) => {
  client.on("error", (err) => {
    console.error(`Redis ${label} error:`, err);
  });
};

export const getRedisUrl = () => redisUrl;

export const getRedisCommandClient = async (): Promise<RedisClientType> => {
  if (!commandClient) {
    commandClient = createClient({ url: redisUrl });
    attachErrorLogger(commandClient, "command");
  }
  if (!commandClient.isOpen) {
    await commandClient.connect();
  }
  return commandClient;
};

export const getRedisPubSubClients = async (): Promise<{
  pubClient: RedisClientType;
  subClient: RedisClientType;
}> => {
  if (!pubClient) {
    pubClient = createClient({ url: redisUrl });
    attachErrorLogger(pubClient, "pub");
  }
  if (!pubClient.isOpen) {
    await pubClient.connect();
  }

  if (!subClient) {
    subClient = pubClient.duplicate();
    attachErrorLogger(subClient, "sub");
  }
  if (!subClient.isOpen) {
    await subClient.connect();
  }

  return { pubClient, subClient };
};
