/**
 * A sandbox profile's layers, drawn the way they nest: the outermost layer is the outer box, each
 * next one sits inside it, and the agent's commands are at the centre.
 */
import type { SandboxProfile } from "@contract";

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

/** The three plain facts of a profile. */
export function ProfileFacts({ profile }: { profile: SandboxProfile }) {
	return (
		<ul className="facts">
			<li>
				<span className="fact-key">approval</span>
				<span className="fact-value">
					<strong>{profile.approval}</strong>
					<span className="fact-gloss">{profile.approval === "auto" ? "runs what the sandbox contains, refuses the rest" : "runs every call without asking"}</span>
				</span>
			</li>
			<li>
				<span className="fact-key">network</span>
				<span className={`fact-value${profile.commandNetwork ? " fact-open" : ""}`}>{profile.commandNetwork ? "commands can reach the network" : "commands have no network"}</span>
			</li>
			<li>
				<span className="fact-key">sign-in</span>
				<span className={`fact-value${profile.commandsCanReadLogin ? " fact-open" : ""}`}>{profile.commandsCanReadLogin ? "commands can read your ChatGPT sign-in" : "commands cannot read your ChatGPT sign-in"}</span>
			</li>
		</ul>
	);
}
