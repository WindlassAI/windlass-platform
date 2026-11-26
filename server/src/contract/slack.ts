import type { GithubId } from "../contract.js";

/** What Settings may show. A member's link is independent of who installed the bot. */
export interface SlackIdentity {
	teamId: string;
	userId: string;
}

export interface SlackConnection {
	workspace: { id: string; name: string };
	botUserId: string;
	connectedAt: number;
}

export interface SlackMapping {
	channel: { id: string; name: string };
	repository: { id: GithubId; owner: string; name: string };
}

export type SlackStatus =
	| { state: "off" }
	| { state: "disconnected"; links: SlackIdentity[] }
	| { state: "connected"; connection: SlackConnection; mappings: SlackMapping[]; links: SlackIdentity[] };

export interface SlackSettingsActions {
	slack(): Promise<SlackStatus>;
	slackConnect(input: { origin: string }): Promise<{ url: string }>;
	/** Complete the callback ticket once, as the account that started the connection. */
	slackComplete(ticket: string): Promise<SlackStatus>;
	saveSlackMapping(input: { channelId: string; repositoryId: GithubId }): Promise<SlackStatus>;
	removeSlackMapping(channelId: string): Promise<SlackStatus>;
	disconnectSlack(): Promise<SlackStatus>;
	/** Redeem the single-use proof sent privately in response to a signed request. */
	linkSlack(ticket: string): Promise<SlackStatus>;
	unlinkSlack(teamId: string): Promise<SlackStatus>;
}

/** Persist the acknowledgement's ts here for a command that didn't have a parent message. */
export interface SlackThread {
	teamId: string;
	channelId: string;
	threadTs: string;
}
