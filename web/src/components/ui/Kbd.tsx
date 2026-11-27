/** A key, as a key cap: "↵", "⇧↵", "esc". `KeyHints` is a quiet row of them with what each does. */
import type { ReactNode } from "react";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return <kbd className={`ui-kbd${className ? ` ${className}` : ""}`}>{children}</kbd>;
}

export function KeyHints({
	hints,
	className,
	id,
}: {
	hints: Array<[key: ReactNode, does: ReactNode]>;
	className?: string;
	id?: string;
}) {
	return (
		<span className={`ui-key-hints${className ? ` ${className}` : ""}`} id={id}>
			{hints.map(([key, does], index) => (
				<span key={index} className="ui-key-hint">
					{index > 0 ? <span className="ui-key-sep" aria-hidden="true" /> : null}
					<Kbd>{key}</Kbd>
					<span>{does}</span>
				</span>
			))}
		</span>
	);
}
