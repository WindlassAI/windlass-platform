// Carry ACP stdio over the real runner's session channel. Only the WebSocket transport is in memory.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../../runner/src/session.ts';
import { ServerChannel } from '../../server/src/runner/channel.ts';
import { RunnerLink, machineLayer } from '../../server/src/sandbox/runner-layer.ts';
import { AcpHarness } from '../../server/src/sandbox/acp-harness.ts';
import { OPENCODE } from '../../server/src/sandbox/harnesses.ts';
import { turnRefusal } from '../../server/src/provider-refusal.ts';

export async function channelTurn(owner, session, id, model, expectedFailure) {
	const runner = new Session(session, owner, () => {});
	const messages = [new EventEmitter(),new EventEmitter()];
	const endpoint = side => ({
		send: data => queueMicrotask(() => messages[1-side].emit('message',data)),
		onMessage: fn => messages[side].on('message',fn),
		close() {}, onClose() {},
	});
	const connected = Promise.withResolvers();
	const server = new ServerChannel({accept: hello => hello.machineId === owner.identity.machineId, onConnect: connected.resolve});
	server.attach(endpoint(0));
	runner.channel.attach(endpoint(1), {machineId:owner.identity.machineId,ticket:'test',signature:'fixture',runnerVersion:'0.1.0'});
	await connected.promise;
	const request = server.request.bind(server);
	const link = {
		who: { ...owner.identity, sessionId: session }, channel: server,
		again: request, request, start: RunnerLink.prototype.start,
		ready: async () => {}, busy: work => work(),
	};
	try {
		const layer = machineLayer(link, {});
		const box = await layer.sandboxes.connect(id);
		assert.ok(box);
		await box.writeTextFile('/workspace/opencode.json', JSON.stringify({enabled_providers: [], default_agent: 'nonexistent'}));
		const harness = new AcpHarness(OPENCODE, 'fixture');
		let previous;
		for (const mode of (session === 'third' ? ['build', 'plan'] : ['plan'])) {
			let reply = '', selected;
			const turn = await harness.runTurn(box, {
				prompt: 'Say relay proof.', mode, model, windlassSessionId: previous,
				signal: AbortSignal.timeout(expectedFailure ? 150000 : 90000),
				onAcpModes(current, choices) {
					assert.deepEqual(choices.map(c => c.id), ['build','plan']);
					selected = current;
				},
				onAcpUpdate(update) {
					if (update.sessionUpdate === 'agent_message_chunk') reply += update.content.text;
				},
			});
			if (expectedFailure) {
				assert.deepEqual(turn.failure, expectedFailure);
				assert.deepEqual(turnRefusal('error', turn, null), {kind:expectedFailure.reason, message:expectedFailure.message});
				return;
			}
			assert.equal(turn.failure, null, JSON.stringify(turn.failure));
			assert.equal(turn.aborted, false);
			assert.equal(turn.acp.stopReason, 'end_turn');
			assert.ok(turn.acp.models.models.length);
			assert.equal(selected, mode);
			assert.equal(reply, 'relay proof');
			if (previous) { assert.equal(turn.resumed, true); assert.equal(turn.windlassSessionId, previous); }
			previous = turn.windlassSessionId;
		}
	} finally {
		runner.channel.close();
		server.close();
	}
}
