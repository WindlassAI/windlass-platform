/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** "1" selects the in-memory mock backend. */
	readonly VITE_WLP_MOCK?: string;
	/** The Rivet endpoint of the real backend; defaults to the contract's DEFAULT_ENDPOINT. */
	readonly VITE_WLP_ENDPOINT?: string;
	/**
	 * The platform's HTTP address (`GET /platform/info`): what spreads requests over the servers. Defaults
	 * to the endpoint's host on port 6440 when the endpoint is on port 6420, else to DEFAULT_PLATFORM_URL.
	 */
	readonly VITE_WLP_API?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
