import { CopyButton } from "./Copy";

/** A command to run on the machine, with the way to copy it. */
export function Command({ text, label }: { text: string; label: string }) {
	return (
		<div className="machine-command">
			<pre tabIndex={0} aria-label={label}>
				{/* A short word, a flag such as "--restart", is never split after its hyphens; a long one, a path or the image's digest, fills its lines. */}
				{text
					.split(/(\s+)/)
					.map((part, index) => (index % 2 === 0 && part.length <= 24 ? <span key={index}>{part}</span> : part))}
			</pre>
			<CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
		</div>
	);
}
