import { Pool } from "./cache.js";

// Acquire only around a leaf network operation, never around a resolver chain.
export const mkvNetwork = new Pool(2);
