/**
 * A cost said in words ("$3.03 + 2 turns on your plan"): its dollar figure large, what else it holds quieter after it.
 * Words without a dollar figure ("On your Claude plan") stay one size. The text reads the same either way.
 */
export function CostFigure({ words }: { words: string }) {
	const [figure, ...rest] = words.split(" + ");
	return (
		<span className="cost-figure">
			<span className={/^[$\d]/.test(figure ?? "") ? "cost-figure-amount" : "cost-figure-words"}>{figure}</span>
			{rest.length ? <span className="cost-figure-rest"> + {rest.join(" + ")}</span> : null}
		</span>
	);
}
