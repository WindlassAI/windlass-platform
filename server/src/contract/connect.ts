/**
 * Subscription plans a user connects and the connect command's wire. No imports: the CLI (`cli/`) bundles this
 * module on its own, so it stays dependency-free and browser-safe.
 */

/**
 * Subscription plans a user can connect, by the provider that serves them. The ChatGPT plan is the user's ChatGPT
 * sign-in (Windlass's own login), the one Windlass's unqualified models already run on.
 */
export const PLAN_PROVIDERS = ["anthropic", "openai"] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];
export const PLAN_NAMES: Record<PlanProvider, string> = { anthropic: "Claude plan", openai: "ChatGPT plan" };

export function isPlanProvider(value: unknown): value is PlanProvider {
	return (PLAN_PROVIDERS as readonly unknown[]).includes(value);
}

/** A Claude plan is connected with the long-lived token `claude setup-token` prints. A ChatGPT plan has no such token: it is a sign-in. */
const PLAN_TOKEN_SHAPES: Partial<Record<PlanProvider, RegExp>> = { anthropic: /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/ };

/** Whether the connect command can connect this plan: only a plan with a token to hand over. */
export function connectsWithToken(provider: PlanProvider): boolean {
	return PLAN_TOKEN_SHAPES[provider] !== undefined;
}

export function validPlanToken(provider: PlanProvider, token: unknown): token is string {
	return typeof token === "string" && (PLAN_TOKEN_SHAPES[provider]?.test(token) ?? false);
}

/**
 * The connect command (`npx @windlassai/cli connect claude`) over HTTP, without signing in: `start` opens a
 * request and answers `ConnectStart`; the user approves its code on the web page (`/connect?code=`); `poll`
 * answers `{ state }`; then the terminal posts `{ request, token }` to `connect` once, answered `{ account }`.
 */
export const CONNECT_PATHS = {
	start: "/platform/connect/start",
	poll: "/platform/connect/poll",
	connect: "/platform/connect",
} as const;

export type ConnectRequestState = "pending" | "approved" | "denied" | "expired";

export interface ConnectStart {
	/** What the terminal shows and the page asks the user to compare, like KQ2M-8XF4. */
	userCode: string;
	/** The web page that approves it, with the code in its query. */
	approveUrl: string;
	/** The terminal's secret: it polls with it and hands the token over with it. Never shown. */
	request: string;
	expiresAt: number;
	/** How often to poll, in milliseconds. */
	interval: number;
}
