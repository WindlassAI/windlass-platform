/** A unified diff, readable: a header per file, numbered lines, added and removed lines coloured. */
import { useMemo } from "react";
import { parseDiff, type DiffFile } from "../lib/diff";
import { plural } from "../lib/format";

const STATUS_WORD: Record<DiffFile["status"], string> = { modified: "modified", added: "new file", deleted: "deleted", renamed: "renamed" };
const SIGN = { add: "+", remove: "-", context: " ", meta: "\\" } as const;

/** The hunks of one file, without its header: also used inside an edit call's body. */
export function DiffHunks({ file }: { file: DiffFile }) {
	if (file.binary) return <p className="diff-note">Binary file: no text to show.</p>;
	if (file.hunks.length === 0) return <p className="diff-note">No changed lines (a mode change or an empty file).</p>;
	return (
		<div className="diff-scroll" tabIndex={0} role="group" aria-label={`Changed lines of ${file.path}`}>
			<table className="diff-table">
				<tbody>
					{file.hunks.map((hunk, hunkIndex) => [
						<tr key={`h${hunkIndex}`} className="diff-hunk">
							<td colSpan={4}>{hunk.header}</td>
						</tr>,
						...hunk.lines.map((line, lineIndex) => (
							<tr key={`${hunkIndex}-${lineIndex}`} className={`diff-line diff-${line.kind}`}>
								<td className="diff-number">{line.oldNumber ?? ""}</td>
								<td className="diff-number">{line.newNumber ?? ""}</td>
								<td className="diff-sign">
									{SIGN[line.kind]}
									{line.kind === "add" ? <span className="visually-hidden">added: </span> : line.kind === "remove" ? <span className="visually-hidden">removed: </span> : null}
								</td>
								<td className="diff-text">{line.kind === "meta" ? line.text : line.text || " "}</td>
							</tr>
						)),
					])}
				</tbody>
			</table>
		</div>
	);
}

export function DiffView({ diff }: { diff: string }) {
	const files = useMemo(() => parseDiff(diff), [diff]);
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);

	if (diff.trim() === "") return <p className="diff-note">Nothing differs from the last commit.</p>;
	// Not a diff this parser knows: show it as it is rather than nothing.
	if (files.length === 0) return <pre className="output-text">{diff}</pre>;

	return (
		<div className="diff">
			<p className="diff-summary">
				<span>{plural(files.length, "file")}</span>
				<span className="diff-added">+{added}</span>
				<span className="diff-removed">-{removed}</span>
			</p>
			{files.map((file) => (
				<section key={file.path} className="diff-file" aria-label={file.path}>
					<header className="diff-file-head">
						<h3 className="diff-path">
							{file.oldPath ? <span className="diff-old-path">{file.oldPath} → </span> : null}
							{file.path}
						</h3>
						<span className="diff-status">{STATUS_WORD[file.status]}</span>
						<span className="diff-added">+{file.added}</span>
						<span className="diff-removed">-{file.removed}</span>
					</header>
					<DiffHunks file={file} />
				</section>
			))}
		</div>
	);
}
