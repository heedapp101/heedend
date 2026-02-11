import "dotenv/config";
import { getRedisCommandClient, getRedisUrl } from "../config/redis.js";

const main = async () => {
  try {
    const url = getRedisUrl();
    console.log(`Checking Redis connection: ${url}`);

    const client = await getRedisCommandClient();
    const pong = await client.ping();

    console.log(`Redis PING response: ${pong}`);
    await client.quit();
    process.exit(0);
  } catch (error) {
    console.error("Redis connection failed:", error);
    process.exit(1);
  }
};

main();
