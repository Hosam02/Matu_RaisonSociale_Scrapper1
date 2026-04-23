import { LRUCache } from "lru-cache";

export const searchCache = new LRUCache({
  max: 5000,              // max entries
  ttl: 1000 * 60 * 60,    // 1 hour
});