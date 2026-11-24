import type { ModelProvider } from "../../server/src/contract.js";

export const wires: Record<ModelProvider | "chatgpt", { base: string }>;
export function forwardHost(value: unknown): value is string;
export function forwardPlaceholder(value: unknown): value is string;
export function validProofKey(value: unknown): value is string;
export const proofHeader: string;
export function forwardProof(key: string, machine: string, method: string, path: string, time: number): string;
