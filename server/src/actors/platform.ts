/** `platform`, key ["main"]: public facts about this deployment. Takes no credentials. */

import { actor } from "rivetkit";
import { assertOrigin, clientError } from "../auth.js";
import type { PlatformInfo } from "../contract.js";
import { platformInfo } from "../platform-info.js";

export const platform = actor({
	options: { name: "Platform", icon: "circle-info" },

	onBeforeConnect: (c) => {
		assertOrigin(c);
	},

	actions: {
		info: async (c): Promise<PlatformInfo> => {
			try {
				return await platformInfo();
			} catch (error) {
				throw clientError(c.log, error, "The platform's information could not be read.");
			}
		},
	},
});
