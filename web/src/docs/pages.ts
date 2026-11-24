/**
 * The docs' pages: one list, in reading order, that everything else reads. The sidebar, the previous and next
 * links, search, the page's title and description, and the build's list of public addresses (prerender,
 * sitemap, llms.txt) all come from here.
 *
 * This module holds metadata only and imports nothing, so a build script run by Node can read it as it is.
 * Each page's text is the Markdown file named by `file`, under `web/src/docs/content/`.
 */

export interface DocsPage {
	/** The page's part of the address: `/docs/<slug>`. The overview's is "", and its address is `/docs`. */
	slug: string;
	/** The page's heading, and its title in the browser and in search results. */
	title: string;
	/** One or two sentences for the page's meta description, the search result and the overview's card. */
	description: string;
	/** The sidebar group it is listed under. */
	section: DocsSection;
	/** The Markdown file under `web/src/docs/content/`. */
	file: string;
}

export const DOCS_SECTIONS = ["Start here", "Agents", "Your machines", "Platform", "Help"] as const;
export type DocsSection = (typeof DOCS_SECTIONS)[number];

export const DOCS_PAGES: readonly DocsPage[] = [
	{
		slug: "",
		title: "Windlass documentation",
		description: "How to run coding agents on Windlass: in a hosted sandbox or on your own machine, on your GitHub repositories, with every turn in view.",
		section: "Start here",
		file: "index.md",
	},
	{
		slug: "getting-started",
		title: "Getting started",
		description: "Get access, sign in with ChatGPT, connect GitHub and start your first agent.",
		section: "Start here",
		file: "getting-started.md",
	},
	{
		slug: "start-an-agent",
		title: "Start an agent",
		description: "Write the prompt, then choose the agent, model, effort, mode, repository and the place it runs.",
		section: "Agents",
		file: "start-an-agent.md",
	},
	{
		slug: "sessions",
		title: "Work with a session",
		description: "Follow the timeline, steer the agent, answer its questions, stop it, read the changes and open a pull request.",
		section: "Agents",
		file: "sessions.md",
	},
	{
		slug: "machines",
		title: "Use your own machine",
		description: "Pair a machine of yours with one Docker command, choose its network mode, and run agents there instead of in a hosted sandbox.",
		section: "Your machines",
		file: "machines.md",
	},
	{
		slug: "cheap-vm",
		title: "Run agents on a cheap cloud VM",
		description: "Choose a small VM, pair its runner and use your own model plans without spending hosted sandbox time.",
		section: "Your machines",
		file: "cheap-vm.md",
	},
	{
		slug: "runner",
		title: "Runner reference",
		description: "Every runner command and option: harnesses, network modes, names, turn limits, CPU caps, allowed profiles, status, logs and pruning.",
		section: "Your machines",
		file: "runner.md",
	},
	{
		slug: "security",
		title: "Sandboxes and security",
		description: "What isolates each agent, what the two Docker profiles protect, what the platform can and cannot do on your machine, and where secrets go.",
		section: "Platform",
		file: "security.md",
	},
	{
		slug: "factory",
		title: "Factory",
		description: "File work items from the page, GitHub or the API, or orchestrate a feature into subtasks, and let the pipeline take each to a reviewed pull request.",
		section: "Platform",
		file: "factory.md",
	},
	{
		slug: "settings",
		title: "Settings, usage and limits",
		description: "Account and repository settings, MCP servers, secrets, API tokens, and the limits on sandbox time and sandboxes.",
		section: "Platform",
		file: "settings.md",
	},
	{
		slug: "troubleshooting",
		title: "Troubleshooting",
		description: "The messages Windlass shows when it refuses or something fails, what each one means and what to do.",
		section: "Help",
		file: "troubleshooting.md",
	},
	{
		slug: "faq",
		title: "FAQ",
		description: "Short answers to common questions about Windlass: access, agents, models, sandboxes, your own machine, self-hosting and licenses.",
		section: "Help",
		file: "faq.md",
	},
	{
		slug: "glossary",
		title: "Glossary",
		description: "The words Windlass uses, from agent and turn to runner, profile and work item, each in a sentence or two.",
		section: "Help",
		file: "glossary.md",
	},
];

/** The address of a page by its slug. */
export function docsPath(slug: string): string {
	return slug === "" ? "/docs" : `/docs/${slug}`;
}

/** The page at a slug, or undefined. */
export function docsPage(slug: string): DocsPage | undefined {
	return DOCS_PAGES.find((page) => page.slug === slug);
}

/**
 * The docs' public addresses, for the build's list of public routes (prerender, sitemap, llms.txt): register
 * these where that list is kept. `title` is the document title the page sets; `description` its meta description.
 */
export function docsRoutes(): { path: string; title: string; description: string; file: string }[] {
	return DOCS_PAGES.map((page) => ({ path: docsPath(page.slug), title: docsTitle(page), description: page.description, file: `web/src/docs/content/${page.file}` }));
}

/** The browser's title for a page. */
export function docsTitle(page: DocsPage): string {
	return page.slug === "" ? "Docs · Windlass" : `${page.title} · Windlass docs`;
}
