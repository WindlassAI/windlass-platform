/**
 * Copying from the conversation: putting text on the clipboard, and what each copy control puts
 * there. What is copied is the source a reader would paste somewhere else (an answer's Markdown, a
 * command as it was run, a file's part of a patch), not the text as the page lays it out.
 */
import { parseDiff } from "./diff";
import type { ToolBlock } from "./timeline";
import { formatInput, parseInput } from "./toolSummary";

/**
 * Puts `text` on the clipboard and says whether it got there. The Clipboard API needs a secure
 * context, and the app also runs on plain http on a local network, where `navigator.clipboard` is
 * missing; there, and when the API refuses, the text is copied from a selected, unseen text area.
 * `near` is the control that asked: the text area goes beside it, because outside an open modal
 * dialog everything is inert and cannot be selected.
 */
export async function copyText(text: string, near?: Element | null): Promise<boolean> {
	const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
	if (clipboard && typeof clipboard.writeText === "function") {
		try {
			await clipboard.writeText(text);
			return true;
		} catch {
			// Refused (no permission, or the document lost focus): the older way may still be allowed.
		}
	}
	return copyBySelection(text, near);
}

function copyBySelection(text: string, near?: Element | null): boolean {
	if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
	const host = near?.closest("dialog") ?? document.body;
	const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const selection = document.getSelection();
	const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : [];

	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.setAttribute("aria-hidden", "true");
	area.tabIndex = -1;
	// Fixed in the corner, so that selecting it scrolls nothing; unseen, and out of the way of the pointer.
	area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;";
	host.append(area);
	let copied = false;
	try {
		area.focus({ preventScroll: true });
		area.select();
		area.setSelectionRange(0, text.length);
		copied = document.execCommand("copy");
	} catch {
		copied = false;
	} finally {
		area.remove();
		// Give back what the reader had: the focus on the control, and any text they had selected.
		focused?.focus({ preventScroll: true });
		if (selection && ranges.length > 0) {
			selection.removeAllRanges();
			for (const range of ranges) selection.addRange(range);
		}
	}
	return copied;
}

/** A tool call's input as it is copied: a command alone, as it would be typed; otherwise what the input part shows. */
export function toolInputText(block: ToolBlock): string {
	const input = parseInput(block.inputText);
	if (input && typeof input.command === "string") return input.command;
	return formatInput(block);
}

/** The patch an edit call shows as its output, when it has one the diff view can read. */
function shownPatch(block: ToolBlock): string | null {
	const diff = block.display?.diff;
	return typeof diff === "string" && parseDiff(diff).length > 0 ? diff : null;
}

/** A tool call's output as it is copied: an edit's patch when that is what it shows, otherwise all of the output (or of what has arrived so far), not only the lines shown. */
export function toolOutputText(block: ToolBlock): string {
	return shownPatch(block) ?? block.output ?? block.progress ?? "";
}

/** What a tool call's two copy controls are called, which says what each one copies. */
export function toolCopyLabels(block: ToolBlock): { input: string; output: string } {
	const name = block.name || "tool";
	const input = parseInput(block.inputText);
	const command = input !== null && typeof input.command === "string";
	const patch = shownPatch(block) !== null;
	return {
		input: command ? `Copy the command of this ${name} call` : `Copy the input of this ${name} call`,
		output: patch ? `Copy the diff of this ${name} call` : `Copy the output of this ${name} call`,
	};
}

/**
 * A unified diff cut into one patch per file: each part starts at its `diff --git` line (or, in a plain
 * `diff -u`, at its `---` line) and can be applied alone. Hunks are followed by their line counts, so
 * that a removed line that reads `--- ...` is not taken for the start of a file.
 */
export function splitDiff(text: string): string[] {
	const lines = text.split("\n");
	const git = lines.some((line) => line.startsWith("diff --git "));
	const starts: number[] = [];
	let oldLeft = 0;
	let newLeft = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (oldLeft > 0 || newLeft > 0) {
			if (line.startsWith("-")) oldLeft--;
			else if (line.startsWith("+")) newLeft--;
			else if (!line.startsWith("\\")) {
				// Context, or a context line whose single space was trimmed away.
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			oldLeft = Number(hunk[1] ?? 1);
			newLeft = Number(hunk[2] ?? 1);
		} else if (git ? line.startsWith("diff --git ") : line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ")) starts.push(index);
	}
	return starts.map((start, index) => {
		const part = lines.slice(start, starts[index + 1] ?? lines.length).join("\n");
		return part.endsWith("\n") ? part : `${part}\n`;
	});
}

/** The text of a code block in rendered Markdown, as it was written: without the newline the renderer ends it with. */
export function codeText(pre: Element): string {
	const code = pre.querySelector("code") ?? pre;
	return (code.textContent ?? "").replace(/\n$/, "");
}
