/**
 * The public pages: every address that is served as prerendered HTML instead of the app's shell, and
 * the one list the build reads to write them, sitemap.xml, robots.txt, llms.txt and llms-full.txt
 * (web/site-build.ts). A page that is not here is a page of the app: it gets app.html, which is not
 * indexed.
 *
 * To add public pages (the docs, say), make `PublicPage`s in a module of your own and spread them into
 * `PUBLIC_PAGES` below. A page's body must render without the browser: no effects run, no state is
 * kept, nothing reads `window`. Its styles go into the app's stylesheet (import them in main.tsx): the
 * prerendered pages link the same stylesheet the app does. The checks in pages.test.ts hold every page
 * to the rules.
 */
import type { ReactElement } from "react";
import { absolute, SITE_NAME, SITE_URL } from "./config";
import { AGENTS, FACTORY_STEPS, FAQ, LANDING_DESCRIPTION, LANDING_TITLE, ONE_LINER, SESSION_FEATURES } from "./content";
import { Landing } from "./Landing";
import { docsPublicPages } from "../docs/public";

export interface PublicPage {
	/** The address: starts with "/", no trailing slash (but "/" itself), no extension. It is written to `<path>/index.html`. */
	path: string;
	/** The whole `<title>`, brand included. Keep it under about 60 characters. */
	title: string;
	/** The meta description and the Open Graph one: one or two plain sentences, under about 160 characters. */
	description: string;
	/** The page's body, rendered to static HTML inside `#root`. */
	render(): ReactElement;
	/** The page as Markdown, for llms-full.txt: what an answer engine should read of it. */
	markdown(): string;
	/** Its line in llms.txt, under `section`. */
	llms: { section: string; summary: string };
	/** Structured data for its head, as JSON-LD objects (each gets "@context" if it has none). */
	jsonLd?: object[];
	/** Open Graph type: "website" for the landing, "article" for a document. */
	ogType?: "website" | "article";
	/** The Open Graph and Twitter image, an absolute path on the site; /og.png when left out. */
	image?: { path: string; alt: string; width: number; height: number };
	/** When its content last changed (YYYY-MM-DD), for sitemap.xml. Left out, the sitemap says nothing of it. */
	lastModified?: string;
	/**
	 * Whether a signed-in visitor is given the app here instead (public/site.js loads it before first
	 * paint): true for "/" only, where the landing and the user's agents share an address.
	 */
	appForSignedIn?: boolean;
	/**
	 * Whether every visitor's browser loads the app's entry here after the static page shows: true for
	 * the docs, whose search, contents and menu need it. The static markup stays visible until the app
	 * replaces it with the same page, so nothing is hidden first.
	 */
	appForEveryone?: boolean;
}

export const DEFAULT_IMAGE = { path: "/og.png", alt: "Windlass: put an agent to work, and watch every turn.", width: 1200, height: 630 };

function landingMarkdown(): string {
	return [
		`# ${SITE_NAME}`,
		"",
		ONE_LINER,
		"",
		"## Sessions",
		"",
		"A session is one agent on one piece of work. It runs turn by turn, and the browser shows each step as it happens.",
		"",
		...SESSION_FEATURES.map((feature) => `- **${feature.title}.** ${feature.text}`),
		"",
		"## Where it runs",
		"",
		"You choose the sandbox when you start an agent, and see its layers before it starts. Your sign-in never goes into the sandbox: each turn is lent a short-lived token.",
		"",
		"- **Hosted.** Each hosted session gets a Firecracker microVM of its own from E2B; commands run as a non-root user.",
		"- **Your own machine.** Pair a Linux machine with Docker. A small runner on it connects out to the platform and runs each session in a container there (non-root, no capabilities, seccomp, resource limits). Nothing on the machine needs to be reachable from outside.",
		"- **The Windlass sandbox profile** sandboxes every command again: no network, writes only in the workspace, credentials hidden. A command that wants more asks first. The hardened profile runs commands directly in the container, with network.",
		"",
		"## Factory",
		"",
		"A work item is a task on one repository that the platform carries from start to pull request by itself. The next step is decided by what the platform observed (checks, CI, the review), never by what the agent says. The platform never merges: the person does, on GitHub.",
		"",
		...FACTORY_STEPS.map((step, index) => `${index + 1}. **${step.label}**: ${step.text}`),
		"",
		"## Agents",
		"",
		...AGENTS.map((agent) => `- **${agent.name}** (${agent.state}): ${agent.where}`),
		"",
		"## Questions",
		"",
		...FAQ.flatMap((item) => [`### ${item.question}`, "", item.answer, ""]),
		"## Access",
		"",
		"Access is by invitation. There is no public sign-up and no pricing yet. Sign in at " + absolute("/signin") + ".",
	].join("\n");
}

const landing: PublicPage = {
	path: "/",
	title: LANDING_TITLE,
	description: LANDING_DESCRIPTION,
	render: () => <Landing />,
	markdown: landingMarkdown,
	llms: { section: "Pages", summary: "What Windlass is: sessions, sandboxes, the Factory, the agents it runs, and answers to common questions." },
	ogType: "website",
	appForSignedIn: true,
	jsonLd: [
		{
			"@type": "WebSite",
			"@id": `${SITE_URL}/#website`,
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			description: LANDING_DESCRIPTION,
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": `${SITE_URL}/#app`,
			name: SITE_NAME,
			url: `${SITE_URL}/`,
			description: ONE_LINER,
			applicationCategory: "DeveloperApplication",
			applicationSubCategory: "Coding agents",
			operatingSystem: "Web browser",
			featureList: [
				"Runs the Windlass and Claude Code coding agents",
				"Hosted sandboxes (E2B microVMs) or your own machine through an outbound runner",
				"Live timeline of every file read and command run",
				"Steering, questions and approvals during a turn",
				"Workspace diffs and pull requests through a GitHub App",
				"Factory: work items carried from task to pull request, with CI read and a second review",
			],
		},
		{
			"@type": "FAQPage",
			"@id": `${SITE_URL}/#faq`,
			mainEntity: FAQ.map((item) => ({
				"@type": "Question",
				name: item.question,
				acceptedAnswer: { "@type": "Answer", text: item.answer },
			})),
		},
	],
};

/** Every public page. Add yours here (see the comment at the top). */
export const PUBLIC_PAGES: PublicPage[] = [landing, ...docsPublicPages().map((page) => ({ ...page, appForEveryone: true }))];
