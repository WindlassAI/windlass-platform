import type { MachineSummary } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { readTwice } from "../lib/retry";
import { useApp, useAuth } from "./app";

export interface MachinesState {
	/** Null until it was read, and when it could not be. */
	list: MachineSummary[] | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
	/** Takes the list as an action answered it. */
	replace(list: MachineSummary[]): void;
}

/**
 * The user's machines: read when the screen opens, then as the user's actor sends them, and again
 * after the live feed was down. `enabled` false asks nothing: for a deployment that offers no machines,
 * and for a screen that needs them only sometimes (a session on a machine).
 */
export function useMachines(enabled = true): MachinesState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ list: MachineSummary[] | null; error: string | null }>({
		list: null,
		error: null,
	});
	const asked = useRef(0);
	const samplesDuringReload = useRef<Map<string, MachineSummary["host"]> | null>(null);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		const samples = new Map<string, MachineSummary["host"]>();
		samplesDuringReload.current = samples;
		readTwice(() => client.user(auth).machines())
			.then(
				list =>
					mine === asked.current &&
					setState({
						list: list.map(machine =>
							samples.has(machine.machineId) ? { ...machine, host: samples.get(machine.machineId) } : machine,
						),
						error: null,
					}),
				(failure: unknown) => mine === asked.current && setState(now => ({ list: now.list, error: explain(failure) })),
			)
			.finally(() => {
				if (samplesDuringReload.current === samples) samplesDuringReload.current = null;
			});
	}, [client, auth, explain]);

	const replace = useCallback((list: MachineSummary[]) => {
		asked.current += 1;
		setState({ list, error: null });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onMachines: replace,
			onMachineHost: ({ machineId, host }) => {
				samplesDuringReload.current?.set(machineId, host ?? undefined);
				setState(now => ({
					...now,
					list:
						now.list?.map(machine =>
							machine.machineId === machineId ? { ...machine, host: host ?? undefined } : machine,
						) ?? null,
				}));
			},
			onConnection: connection => {
				if (connection !== "connected") return;
				// What the actor sent while the feed was down is lost: the list is read again when it is back.
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, reload, replace, enabled]);

	return { ...state, reload, replace };
}
