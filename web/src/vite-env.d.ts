/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** "1" selects the in-memory mock backend. */
	readonly VITE_WLP_MOCK?: string;
	/**
	 * The Rivet endpoint of the real backend, for a server that names none (development); defaults to the
	 * contract's DEFAULT_ENDPOINT. A deployment's server says where its engine is, and with which token.
	 */
	readonly VITE_WLP_ENDPOINT?: string;
	/**
	 * The platform's HTTP address (`GET /platform/info`, `GET /platform/connection`): what spreads requests
	 * over the servers, and all a deployment's web app is built with. Defaults to the endpoint's host on
	 * port 6440 when the endpoint is on port 6420, else to DEFAULT_PLATFORM_URL.
	 */
	readonly VITE_WLP_API?: string;
	/** The public origin the prerendered pages are canonical at (src/site/config.ts). */
	readonly VITE_WLP_SITE_URL?: string;
	/** Where the public pages' "Request access" leads; unset, they offer "Sign in" alone (src/site/config.ts). */
	readonly VITE_WLP_ACCESS_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
