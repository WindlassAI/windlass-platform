/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** "1" selects the in-memory mock backend. */
	readonly VITE_WLP_MOCK?: string;
	/** The Rivet endpoint of the real backend; defaults to the contract's DEFAULT_ENDPOINT. */
	readonly VITE_WLP_ENDPOINT?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
