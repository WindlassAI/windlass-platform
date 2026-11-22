import type { ItemView } from "@contract";
import { ReviewText } from "./ReviewBlocks";

export function GithubFeedback({ view }: { view: ItemView }) {
	const feedback = view.feedback;
	if (!feedback || (!feedback.batches.length && !feedback.notTaken)) return null;
	return (
		<section className="usage-section" aria-labelledby="github-feedback-title">
			<h2 className="usage-title" id="github-feedback-title">From GitHub</h2>
			{feedback.batches.map(batch => (
				<article key={batch.entries[0]?.id}>
					<p>{batch.reason} {batch.plan ? <a href={`#feature-plan-${batch.plan}`}>Plan {batch.plan}</a> : null}</p>
					{batch.plan && batch.savedPlan && view.plan?.version !== batch.plan ? (
						<div id={`feature-plan-${batch.plan}`}>
							<h3>Plan {batch.plan}</h3>
							<ReviewText text={[batch.savedPlan.goal, ...batch.savedPlan.subtasks.map(title => "- " + title)].join("\n")} />
						</div>
					) : null}
					{batch.entries.map(e => (
						<div key={e.id}>
							<p className="usage-note">
								<a href={e.url}>@{e.author}</a> ({e.access}) · {e.kind.replaceAll("_", " ")} · <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleString()}</time>
							</p>
							{e.path ? <ReviewText text={e.path + (e.line ? ":" + e.line : "")} /> : null}
							<ReviewText text={e.body} />
						</div>
					))}
				</article>
			))}
			{feedback.notTaken > 0 ? <p className="usage-note">Feedback from people without write access skipped · {feedback.notTaken}</p> : null}
		</section>
	);
}
