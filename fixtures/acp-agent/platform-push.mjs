// A person's turn with push, fetch_base and publish over MCP, for the Claude Code and OpenCode Docker checks: the
// platform's server for the turn (server/src/platform-tools.ts, with its limits), handlers that check a push as the
// session does (`pushRequest`) and record that each call came over MCP, and a publish that answers only after
// `publishWaitMs`, longer than an MCP client's default timeout, as a publish that waits for the person does.
// The scripted model (fixtures/claude-relay/upstream.cjs, fixtures/opencode/upstream.cjs, "Platform push check.")
// pushes, pushes naming main, fetches the base and publishes, then says "platform push passed".
import assert from 'node:assert/strict';

export const PUSH_PROMPT = 'Platform push check.';
export const PUSH_REPLY = 'platform push passed';

export async function pushTurnServer({ publishWaitMs }) {
	const { PlatformMcpServer, platformToolDeclarations } = await import('../../server/src/platform-tools.ts');
	const { fetchedForAgent, pushRequest } = await import('../../server/src/agent-publish.ts');
	const { NO_REDACTION } = await import('../../server/src/repo-secrets.ts');
	const branch = 'windlass/relay-push-check';
	const calls = [];
	const permissions = [];
	let running = false;
	const handlers = new Map([
		['publish', async (request) => {
			calls.push(['publish', request.via]);
			await new Promise((resolve) => setTimeout(resolve, publishWaitMs));
			return 'Published after the person allowed it.';
		}],
		['push', async (request) => {
			const checked = pushRequest(request.arguments, { branch, title: 'Relay' }, NO_REDACTION);
			calls.push(['push', request.via, checked.ok ? checked.commit : 'refused']);
			return checked.ok ? `Pushed to ${branch}.` : checked.told;
		}],
		['fetch_base', async (request) => {
			calls.push(['fetch_base', request.via]);
			return fetchedForAgent('main', branch);
		}],
	]);
	const server = new PlatformMcpServer(handlers, platformToolDeclarations(handlers, { screenshots: false, mcp: true }), () => running);
	const refused = pushRequest({ branch: 'main' }, { branch, title: 'Relay' }, NO_REDACTION);
	return {
		server,
		/** The adapter's own permission requests, answered with a refusal: none is expected, the image's policy lets the tools through. */
		permission(params) {
			permissions.push(params.toolCall?.title ?? '');
			const reject = (params.options ?? []).find((o) => o.kind === 'reject_once');
			return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
		},
		set running(value) { running = value; },
		/** After the turn: what reached the handlers, what the model was told (from the upstream's log), and that nothing asked. */
		check(log) {
			assert.deepEqual(permissions, [], 'the agent asked before a platform tool: ' + permissions.join(', '));
			assert.deepEqual(calls, [['push', 'mcp', 'From the relay'], ['push', 'mcp', 'refused'], ['fetch_base', 'mcp'], ['publish', 'mcp']]);
			const told = [`Pushed to ${branch}.`, refused.told, fetchedForAgent('main', branch), 'Published after the person allowed it.'].join(' | ');
			assert.ok(log.includes('platform push results=4 told=' + JSON.stringify(told)), 'the model was not told what the handlers said: ' + log.split('\n').filter((l) => l.startsWith('platform push')).join(' / '));
		},
	};
}
