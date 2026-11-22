/**
 * A sandbox profile's layers, drawn the way they nest: the outermost layer is the outer box, each
 * next one sits inside it, and the agent's commands are at the centre.
 */
import type { SandboxProfile, SessionMode } from "@contract";

/** "Docker container (non-root, no capabilities)" → name and detail. */
function splitLayer(layer: string): { name: string; detail: string | null } {
	const match = /^(.*?)\s*\((.*)\)\s*$/.exec(layer);
	return match?.[1] && match[2] ? { name: match[1], detail: match[2] } : { name: layer, detail: null };
}

function Nested({ layers, depth, compact }: { layers: string[]; depth: number; compact: boolean }) {
	const [first, ...rest] = layers;
	if (first === undefined) {
		return (
			<div className="layer-core">
				<span className="layer-core-dot" aria-hidden="true" />
				the agent's commands
			</div>
		);
	}
	const { name, detail } = splitLayer(first);
	return (
		<div className="layer" data-depth={depth}>
			<div className="layer-label">
				<span className="layer-index" aria-hidden="true">
					{depth + 1}
				</span>
				<span className="layer-name">{name}</span>
				{detail && !compact ? <span className="layer-detail">{detail}</span> : null}
			</div>
			<Nested layers={rest} depth={depth + 1} compact={compact} />
		</div>
	);
}

export function Layers({ profile, compact = false }: { profile: Pick<SandboxProfile, "layers" | "name">; compact?: boolean }) {
	const sentence = profile.layers.length === 0 ? "No isolation layers are listed." : `Isolation, outermost first: ${profile.layers.join("; then ")}.`;
	return (
		<div className={`layers${compact ? " layers-compact" : ""}`} role="img" aria-label={sentence}>
			<Nested layers={profile.layers} depth={0} compact={compact} />
		</div>
	);
}

/**
 * Claude Code in a sandbox: the mode it runs in stands for the profile's approval, and its sign-in is
 * the machine owner's Claude login.
 */
export interface ClaudeFacts {
	mode: SessionMode;
	opencode?: boolean;
}

export function commandNetworkFact(profile: SandboxProfile, claude: ClaudeFacts | null) {
	if (claude?.opencode && !profile.commandNetwork && profile.available)
		return "commands can reach this session’s OpenCode model relay";
	if (claude && profile.claudeRelay && !profile.commandNetwork && profile.available)
		return "commands can reach only this session’s Claude model relay";
	return profile.commandNetworkText ?? (profile.commandNetwork ? "commands can reach the network" : "commands have no network");
}

export function accessTokenFact(profile: SandboxProfile): string {
	const commands = !profile.commandsCanReadAccessToken ? "The agent's commands cannot read the session's access token."
		: profile.id === "e2b" ? "A command you allow outside the Windlass sandbox can read the session's access token and its replacements."
		: "Unsandboxed commands can read the session's access token and its replacements during the turn.";
	return commands + " Setup finishes before handoff. Approved local MCP servers can read each token. Each token lasts about an hour from issue.";
}

export function claudeLoginFact(profile: SandboxProfile) {
	return profile.claudeRelay ? "The machine’s relay holds the setup token." : "Runners without a credential relay also expose the setup token.";
}

/**
 * The three plain facts of a profile. The ChatGPT sign-in is in no sandbox; what a profile decides is
 * whether the agent's commands can read the short-lived access token a turn is handed. For Claude Code
 * (`claude`) the approval is its mode, and its commands can use the Claude login it runs with.
 */
export function ProfileFacts({ profile, claude = null }: { profile: SandboxProfile; claude?: ClaudeFacts | null }) {
	return (
		<ul className="facts">
			<li>
				<span className="fact-key">approval</span>
				{claude ? (
					<span className="fact-value">
						<strong>{claude.mode.name}</strong>
						{claude.mode.description ? <span className="fact-gloss">{claude.mode.description}</span> : null}
					</span>
				) : (
					<span className="fact-value">
						<strong>{profile.approval}</strong>
						<span className="fact-gloss">{profile.approval === "auto" ? "runs what the sandbox contains, refuses the rest" : "runs every call without asking"}</span>
					</span>
				)}
			</li>
			<li>
				<span className="fact-key">network</span>
				<span className={`fact-value${profile.commandNetwork ? " fact-open" : ""}`}>{commandNetworkFact(profile, claude)}</span>
			</li>
			<li>
				<span className="fact-key">sign-in</span>
				{claude ? (
					<span className="fact-value fact-open">{claude.opencode ? "Commands can use the OpenCode model relay. Provider credentials stay on the machine." : <>commands in this container can use your Claude login. {claudeLoginFact(profile)}</>}</span>
				) : (
					<span className="fact-value">
						your ChatGPT sign-in is never in the sandbox
						<span className={`fact-gloss${profile.commandsCanReadAccessToken ? " fact-open" : ""}`}>
							{accessTokenFact(profile)}
						</span>
					</span>
				)}
			</li>
		</ul>
	);
}
