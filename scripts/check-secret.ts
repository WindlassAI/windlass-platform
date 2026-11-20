import { randomBytes } from "node:crypto";

// Import before server configuration so a multi-node check shares a key without writing .data/secret.
process.env.WLP_SECRET ||= randomBytes(32).toString("hex");
