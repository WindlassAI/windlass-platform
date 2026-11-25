import type { S3Settings } from "../server/src/bucket/s3.js";
import { backupConfig } from "../server/src/config.js";

export function bucketSettings(): S3Settings | null {
	const configured = backupConfig().bucket;
	if (configured !== null) return configured;

	const read = (name: string) => (process.env[name] ?? "").trim();
	const endpoint = read("R2_ENDPOINT");
	const bucket = read("R2_BUCKET");
	const accessKeyId = read("R2_ACCESS_KEY_ID");
	const secretAccessKey = read("R2_SECRET_ACCESS_KEY");
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	return { endpoint, region: "auto", bucket, accessKeyId, secretAccessKey, style: "path" };
}
