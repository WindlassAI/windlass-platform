const offset = Number(process.env.WLP_CHECK_PORT_OFFSET ?? 0);
if (!Number.isSafeInteger(offset) || offset % 1000 !== 0) {
	throw new Error("WLP_CHECK_PORT_OFFSET must be a multiple of 1000");
}

export function checkPort(base: number): number {
	const port = base + offset;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Check port ${base} with offset ${offset} is outside 1–65535`);
	return port;
}
