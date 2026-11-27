/** Endpoints, paths and size limits shared by the actors, runner and web app. */

/** Where the server's Rivet endpoint listens in development. */
export const DEFAULT_ENDPOINT = "http://localhost:6420";
/** Origin for the server's own routes in development. */
export const DEFAULT_PLATFORM_URL = "http://localhost:6440";
/** `GET` on the platform's HTTP address: this deployment's `PlatformInfo`, as JSON. */
export const PLATFORM_INFO_PATH = "/platform/info";
/** Fetch at startup and again when the browser connection token expires. */
export const PLATFORM_CONNECTION_PATH = "/platform/connection";

export const MAX_PROMPT_CHARS = 20_000;
/** The longest `IdempotencyKey`, in characters: the Agent Client Protocol's limit. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;
/** How many of a session's messages that came with a key have theirs remembered: the newest. */
export const MAX_REMEMBERED_SUBMISSIONS = 50;
/** The title of a commit or pull request, and its body. */
export const MAX_PUBLISH_TITLE_CHARS = 120;
export const MAX_PUBLISH_BODY_CHARS = 4_000;
export const MAX_TITLE_CHARS = 80;
/** The note sent with an answer to a question. */
export const MAX_NOTE_CHARS = 2_000;
/** A repository's setup command. */
export const MAX_SETUP_COMMAND_CHARS = 2_000;
/** How much of a setup run's output is kept, and shown while it runs: the end of it. */
export const SETUP_OUTPUT_CHARS = 32_000;
/** A repository's checks: how many one repository may have, and Windlass's own limit on how long one may run. */
export const MAX_CHECKS_PER_REPOSITORY = 20;
/** How many hosts one repository's network list may come to, presets expanded. */
export const MAX_REPOSITORY_HOSTS = 40;
export const MAX_CHECK_NAME_CHARS = 64;
export const MAX_CHECK_TIMEOUT_SECONDS = 3600;
/** How many glob patterns one check's `when` may hold, and how long one may be. */
export const MAX_CHECK_PATTERNS = 20;
export const MAX_CHECK_PATTERN_CHARS = 200;
/** How much of a check's output the platform keeps for a pull request's description: the end of it. */
export const CHECK_OUTPUT_CHARS = 1_500;
/** A repository's secrets: how many one repository may have, and what a name and a value may be. */
export const MAX_SECRETS_PER_REPOSITORY = 50;
export const MAX_SECRET_NAME_CHARS = 64;
/** A shorter value could not be taken out of what is shown without taking ordinary words with it. */
export const MIN_SECRET_VALUE_CHARS = 8;
/** In bytes of UTF-8: every secret of a repository is in the environment of one process. */
export const MAX_SECRET_VALUE_BYTES = 16_384;
/** How many repositories one user may have defaults for; the ones saved longest ago go first. */
export const MAX_REPOSITORY_DEFAULTS = 500;
/** The user's own MCP servers: how many one account may keep, and how long one's definition may be as JSON, in bytes of UTF-8. */
export const MAX_PERSONAL_SERVERS = 20;
export const MAX_SERVER_DEFINITION_BYTES = 8_192;
/** A server's name in Windlass's configuration: at most this many characters. */
export const MAX_SERVER_NAME_CHARS = 64;
/** How many secrets one account may keep for its MCP servers. */
export const MAX_ACCOUNT_SECRETS = 50;
/** Interactive prompts hold a sandbox while waiting. Work-item questions close the turn and can wait longer. */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
/** How many machines a user may have paired at once. */
export const MAX_MACHINES = 3;
/** A work item's body, in characters. */
export const MAX_ITEM_BODY_CHARS = 20_000;
export const MAX_ACCEPTANCE_CRITERIA = 20;
export const MAX_API_TOKENS = 20;
/** A machine whose runner has not been heard from for this long is removed, its sandboxes left where they are. */
export const MACHINE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
/** How many days of sandbox time the usage page lists, today included. */
export const USAGE_HISTORY_DAYS = 14;
/** The share of the day's allowance below which a session says how little is left. */
export const USAGE_LOW_SHARE = 0.2;
