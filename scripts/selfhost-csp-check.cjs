// Requires Playwright and its Chromium (or CHROMIUM_EXECUTABLE). Use a loopback demo stack.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function check() {
	const origin = process.argv[2] ?? "http://127.0.0.1:16440";
	assert.equal(new URL(origin).hostname, "127.0.0.1");
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
	try {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			window.policyViolations = [];
			document.addEventListener("securitypolicyviolation", event => window.policyViolations.push(event.effectiveDirective + "/" + event.blockedURI.split("?")[0]));
		});
		const pageResponse = await page.goto(origin);
		const gateway = new URL(await page.evaluate(async () => (await (await fetch("/platform/connection")).json()).endpoint));
		const hsts = await pageResponse.headerValue("strict-transport-security");
		assert.equal(hsts, origin.startsWith("https:") ? "max-age=31536000" : null);
		assert.equal(gateway.hostname, "127.0.0.1");
		const action = page.waitForResponse(response => {
			const url = new URL(response.url());
			return url.origin === origin && url.pathname === "/platform/login/demo" && response.ok();
		});
		const feed = page.waitForEvent("websocket", ws => {
			const url = new URL(ws.url());
			return url.host === gateway.host && url.pathname === "/gateway/user/connect";
		}).then(ws => ws.waitForEvent("framereceived"));
		await Promise.all([action, feed, page.getByRole("button", { name: "Try the demo" }).click()]);
		// cbor-x and Zod probe dynamic code generation and catch the refusal. Their
		// interpreter paths have just completed both the action and WebSocket read.
		const violations = await page.evaluate(() => window.policyViolations);
		assert.deepEqual(violations.filter(v => v !== "script-src/eval"), [], "Unexpected resource blocked by CSP");
		// Insert into the rendered DOM, past the markdown sanitizer. Chromium must enforce the policy.
		const ran = await page.evaluate(() => {
			const script = document.createElement("script");
			script.textContent = "window.inlineProbeRan = true";
			document.body.appendChild(script);
			return !!window.inlineProbeRan;
		});
		assert.equal(ran, false, "Injected inline script executed");
		await page.waitForFunction(() => window.policyViolations.includes("script-src-elem/inline"));
		assert.match(await pageResponse.headerValue("content-security-policy"), /frame-ancestors 'none'/);
		console.log("PASS built page, demo action, user WebSocket frame, blocked inline script (" + violations.length + " blocked eval probes)");
	} finally { await browser.close(); }
}
check().catch(error => { console.error(error.name + ": " + error.message.split("\n")[0]); process.exitCode = 1; });
