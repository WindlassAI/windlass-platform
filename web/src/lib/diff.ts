/** A parser for `git diff` output: files, hunks and numbered lines, for the diff view. */

export interface DiffLine {
	kind: "context" | "add" | "remove" | "meta";
	text: string;
	oldNumber: number | null;
	newNumber: number | null;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface DiffFile {
	path: string;
	oldPath: string | null;
	status: "modified" | "added" | "deleted" | "renamed";
	binary: boolean;
	added: number;
	removed: number;
	hunks: DiffHunk[];
}

const stripPrefix = (path: string): string => path.replace(/^[ab]\//, "");

export function parseDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldNumber = 0;
	let newNumber = 0;

	const begin = (path: string): DiffFile => {
		const created: DiffFile = { path, oldPath: null, status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
		files.push(created);
		hunk = null;
		return created;
	};

	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			file = begin(match?.[2] ?? line.slice("diff --git ".length));
			continue;
		}
		if (line.startsWith("--- ") && hunk === null) {
			// A diff without the `diff --git` line (plain `diff -u`) starts a file here.
			if (file === null || file.hunks.length > 0) file = begin(stripPrefix(line.slice(4)));
			if (line.slice(4) === "/dev/null") file.status = "added";
			continue;
		}
		if (file === null) continue;
		if (line.startsWith("+++ ") && hunk === null) {
			if (line.slice(4) === "/dev/null") file.status = "deleted";
			else file.path = stripPrefix(line.slice(4));
			continue;
		}
		if (hunk === null || line.startsWith("@@")) {
			if (line.startsWith("new file mode")) file.status = "added";
			else if (line.startsWith("deleted file mode")) file.status = "deleted";
			else if (line.startsWith("rename from ")) {
				file.status = "renamed";
				file.oldPath = line.slice("rename from ".length);
			} else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
		}
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			oldNumber = Number(header[1]);
			newNumber = Number(header[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (hunk === null) continue;
		if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", text: line.slice(1), oldNumber: null, newNumber: newNumber++ });
			file.added++;
		} else if (line.startsWith("-")) {
			hunk.lines.push({ kind: "remove", text: line.slice(1), oldNumber: oldNumber++, newNumber: null });
			file.removed++;
		} else if (line.startsWith(" ")) {
			hunk.lines.push({ kind: "context", text: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
		} else if (line.startsWith("\\")) {
			hunk.lines.push({ kind: "meta", text: line.slice(2), oldNumber: null, newNumber: null });
		} else if (line === "") {
			// A context line whose single space was trimmed away, unless it is the newline that ends the text.
			if (index < lines.length - 1 && !(lines[index + 1] ?? "").startsWith("diff --git ")) hunk.lines.push({ kind: "context", text: "", oldNumber: oldNumber++, newNumber: newNumber++ });
		} else {
			hunk = null;
		}
	}
	return files;
}
