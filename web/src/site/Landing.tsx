/**
 * The public landing page, at `/` for people who are not signed in. It is rendered twice from this one
 * component: to static HTML at build time (web/site-build.ts), which is what a visitor, a crawler or an
 * answer engine gets with no JavaScript at all, and by the app itself when a signed-out person lands on
 * `/` inside it. So it holds no state and reads nothing from the browser: what moves is CSS, and the
 * theme button is wired by whoever renders it (`onToggleTheme` in the app, public/site.js on the
 * static page).
 *
 * The page hangs on one line, the windlass's: it pays out from the drum at the top as the page is
 * read, past each chapter's knot, to the weight at the foot.
 *
 * The product pictures are illustrations made from the app's own glyphs and tokens, not screenshots:
 * they say so in their captions.
 */
import type { ReactNode } from "react";
import { AskIcon, CheckIcon, MergedIcon, MoonIcon, PullRequestIcon, SunIcon, ThoughtIcon } from "../components/Icons";
import { ACCESS_URL } from "./config";
import { AGENTS, FACTORY_STEPS, FAQ, SESSION_FEATURES } from "./content";

export function Landing({ onToggleTheme }: { onToggleTheme?: () => void }) {
	return (
		<div className="landing">
			<a className="landing-skip" href="#main">
				Skip to the content
			</a>
			<SiteBar onToggleTheme={onToggleTheme} />
			<main id="main" className="landing-main">
				<div className="landing-line" aria-hidden="true" />
				<Hero />
				<Sessions />
				<Sandboxes />
				<Factory />
				<Agents />
				<Questions />
				<Closing />
			</main>
			<SiteFoot />
		</div>
	);
}

/* ---- the bar ------------------------------------------------------------------------------------ */

/** The drum of the mark, as its own group so that it can turn while the line pays out. */
function MarkGlyph({ size }: { size: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false" className="mark">
			<g className="mark-drum landing-drum-turn">
				<circle cx="11.5" cy="11.5" r="7.5" />
				<path d="M11.5 4v4.2M5 15.25l3.64-2.1M18 15.25l-3.64-2.1" />
				<circle cx="11.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
			</g>
			<path d="M19 11.5V23" />
			<rect x="17" y="22" width="4" height="4" rx="1" fill="currentColor" stroke="none" />
		</svg>
	);
}

function SiteBar({ onToggleTheme }: { onToggleTheme?: () => void }) {
	return (
		<header className="landing-bar">
			<div className="landing-bar-inner">
				<a className="wordmark landing-wordmark" href="/" aria-label="Windlass, home">
					<MarkGlyph size={22} />
					<span className="wordmark-name">windlass</span>
				</a>
				<nav className="landing-nav" aria-label="On this page">
					<a href="#sessions">Sessions</a>
					<a href="#sandboxes">Sandboxes</a>
					<a href="#factory">Factory</a>
					<a href="#agents">Agents</a>
					<a href="#questions">FAQ</a>
					<a href="/docs">Docs</a>
				</nav>
				<div className="landing-bar-end">
					<button type="button" className="icon-button landing-theme" data-theme-toggle="" aria-label="Switch between the light and dark theme" title="Switch theme" onClick={onToggleTheme}>
						<SunIcon className="landing-theme-sun" />
						<MoonIcon className="landing-theme-moon" />
					</button>
					<a className="button button-outline button-small landing-signin" href="/signin">
						Sign in
					</a>
				</div>
			</div>
		</header>
	);
}

/** The ways in: "Request access" where the deployment names a place for it, and always "Sign in". */
function Calls({ large = false }: { large?: boolean }) {
	const size = large ? " button-large" : "";
	return (
		<div className="landing-calls">
			{ACCESS_URL ? (
				<>
					<a className={`button button-primary${size}`} href={ACCESS_URL}>
						Request access
					</a>
					<a className={`button button-outline${size}`} href="/signin">
						Sign in
					</a>
				</>
			) : (
				<a className={`button button-primary${size}`} href="/signin">
					Sign in
				</a>
			)}
			<p className="landing-calls-note">By invitation for now. No public sign-up, no pricing yet.</p>
		</div>
	);
}

/* ---- the hero ----------------------------------------------------------------------------------- */

function Hero() {
	return (
		<section className="landing-hero landing-grid" aria-labelledby="hero-title">
			<div className="landing-rail">
				<svg className="landing-drum" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
					<g className="landing-drum-turn" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
						<circle cx="32" cy="32" r="24" />
						<path d="M32 8v13M11.2 44l11.4-6.6M52.8 44l-11.4-6.6" />
						<circle cx="32" cy="32" r="4" fill="currentColor" stroke="none" />
					</g>
				</svg>
			</div>
			<div className="landing-hero-body">
				<div className="landing-hero-text">
					<p className="eyebrow landing-eyebrow">Coding agents, in sandboxes you choose</p>
					<h1 id="hero-title" className="landing-title">
						Put an agent to work, and <em>watch every turn.</em>
					</h1>
					<p className="landing-lede">
						Windlass runs coding agents for you — its own agent, Windlass, and Claude Code — each in a sandbox of its own: hosted, or on a machine of yours. You see every file it reads and every command it runs, answer what it asks, and take the work as a pull request.
					</p>
					<Calls large />
				</div>
				<SessionPicture />
			</div>
		</section>
	);
}

/** A row of the timeline as the app draws it: a glyph, a verb in mono, its subject, then quiet facts. */
function ToolRow({ verb, subject, facts, step }: { verb: string; subject: ReactNode; facts: string; step: number }) {
	return (
		<li className={`pic-row pic-s${step}`}>
			<CheckIcon size={14} className="pic-ok" />
			<span className="pic-verb">{verb}</span>
			<span className="pic-subject">{subject}</span>
			<span className="pic-facts">· {facts}</span>
		</li>
	);
}

function SessionPicture() {
	return (
		<figure className="landing-picture pic-session">
			<div className="pic-window" aria-hidden="true">
				<div className="pic-bar">
					<MarkGlyph size={16} />
					<span className="pic-crumb">Fix the slug test and open a pull request</span>
					<span className="pic-status">
						<span className="pic-status-working">
							<span className="pic-status-dot" /> working
						</span>
						<span className="pic-status-idle">
							<span className="pic-status-dot" /> idle
						</span>
					</span>
				</div>
				<ol className="pic-timeline">
					<li className="pic-prompt pic-s0">
						<span className="pic-caret">›</span> The slugify test fails on punctuation. Fix it and open a pull request.
					</li>
					<li className="pic-thought pic-s1">
						<ThoughtIcon size={14} /> <em>thought</em> · Leading punctuation turns into dashes at the ends.
					</li>
					<ToolRow step={2} verb="read" subject="slugify/slugify.js" facts="8 lines · 9ms" />
					<ToolRow step={3} verb="edit" subject="slugify/slugify.js" facts="+2 −1 · 6ms" />
					<ToolRow step={4} verb="shell" subject={<code>node --test</code>} facts="exit 0 · 820ms" />
					<li className="pic-text pic-s5">
						Fixed: <code>slugify</code> now trims dashes at both ends, and both tests pass.
					</li>
					<li className="pic-done pic-s6">
						<CheckIcon size={14} className="pic-ok" />
						<span className="pic-verb">done</span> · checks passed · 5 steps
						<span className="pic-pr">
							<PullRequestIcon size={13} /> pull request opened
						</span>
					</li>
				</ol>
				<div className="pic-composer">
					<span className="pic-caret">›</span>
					<span className="pic-placeholder">Tell the agent what to do</span>
					<span className="pic-cursor" />
				</div>
			</div>
			<figcaption className="landing-caption">A session, drawn with the app’s own parts. Illustration, not a recording.</figcaption>
		</figure>
	);
}

/* ---- the chapters ------------------------------------------------------------------------------- */

function Chapter({ id, number, eyebrow, title, lede, children, wide = false }: { id: string; number: string; eyebrow: string; title: ReactNode; lede: ReactNode; children: ReactNode; wide?: boolean }) {
	return (
		<section id={id} className={`landing-chapter landing-grid${wide ? " landing-chapter-wide" : ""}`} aria-labelledby={`${id}-title`}>
			<div className="landing-rail">
				<span className="landing-knot" aria-hidden="true" />
				<span className="landing-number" aria-hidden="true">
					{number}
				</span>
			</div>
			<div className="landing-chapter-body">
				<header className="landing-chapter-head">
					<p className="eyebrow">
						<span className="landing-number-inline" aria-hidden="true">
							{number} ·{" "}
						</span>
						{eyebrow}
					</p>
					<h2 id={`${id}-title`} className="landing-h2">
						{title}
					</h2>
					<p className="landing-chapter-lede">{lede}</p>
				</header>
				{children}
			</div>
		</section>
	);
}

function Sessions() {
	return (
		<Chapter
			id="sessions"
			number="01"
			eyebrow="Sessions"
			title={
				<>
					You stay in the loop, <em>not in the way.</em>
				</>
			}
			lede="A session is one agent on one piece of work. It runs turn by turn, and the browser shows each step as it happens, so you can step in when it matters and leave it alone when it does not."
		>
			<div className="landing-split">
				<ul className="landing-features">
					{SESSION_FEATURES.map((feature) => (
						<li key={feature.key} className="landing-feature">
							<h3 className="landing-feature-title">{feature.title}</h3>
							<p>{feature.text}</p>
						</li>
					))}
				</ul>
				<QuestionPicture />
			</div>
		</Chapter>
	);
}

function QuestionPicture() {
	return (
		<figure className="landing-picture pic-question">
			<div className="pic-stack" aria-hidden="true">
				<div className="pic-card pic-ask">
					<p className="pic-ask-head">
						<AskIcon size={15} /> The agent asks
					</p>
					<p className="pic-ask-text">
						Run <code>pnpm install</code> with network access?
					</p>
					<p className="pic-ask-why">The command needs the registry. Commands have no network in this sandbox.</p>
					<div className="pic-ask-choices">
						<span className="pic-choice pic-choice-main">Allow once</span>
						<span className="pic-choice">For this session</span>
						<span className="pic-choice">Decline…</span>
					</div>
				</div>
				<div className="pic-card pic-diff">
					<p className="pic-diff-head">
						<span>slugify/slugify.js</span>
						<span>
							<span className="pic-add">+2</span> <span className="pic-del">−1</span>
						</span>
					</p>
					<pre className="pic-diff-body">
						<span className="pic-line">{"  return text.toLowerCase()"}</span>
						<span className="pic-line pic-line-del">{"-    .replace(/[^a-z0-9]+/g, \"-\");"}</span>
						<span className="pic-line pic-line-add">{"+    .replace(/[^a-z0-9]+/g, \"-\")"}</span>
						<span className="pic-line pic-line-add">{"+    .replace(/^-+|-+$/g, \"\");"}</span>
					</pre>
				</div>
			</div>
			<figcaption className="landing-caption">A question, and the diff after the turn. Illustration.</figcaption>
		</figure>
	);
}

function Sandboxes() {
	return (
		<Chapter
			id="sandboxes"
			number="02"
			eyebrow="Where it runs"
			title={
				<>
					Hosted, or on your own machine. <em>Always in a box.</em>
				</>
			}
			lede="You choose the sandbox when you start an agent, and see its layers before it starts. Your sign-in never goes in: each turn is lent a short-lived token."
			wide
		>
			<div className="landing-places">
				<article className="landing-place">
					<p className="landing-place-kicker">hosted</p>
					<h3 className="landing-place-title">A microVM of its own</h3>
					<p className="landing-place-text">Each hosted session gets a Firecracker microVM from E2B. Nothing to install: start an agent from the browser.</p>
					<Layers
						layers={[
							{ name: "E2B microVM", detail: "Firecracker, hosted by E2B; commands run as a non-root user" },
						]}
					/>
					<dl className="landing-facts">
						<div>
							<dt>idle</dt>
							<dd>Suspended when nobody uses it; your next prompt resumes it with its files.</dd>
						</div>
						<div>
							<dt>sign-in</dt>
							<dd>Never in the sandbox. Each turn is lent a short-lived token.</dd>
						</div>
						<div>
							<dt>time</dt>
							<dd>Sandbox time counts against a daily allowance, on your usage page.</dd>
						</div>
					</dl>
				</article>

				<div className="landing-place-link" aria-hidden="true">
					<span className="landing-platform">
						<MarkGlyph size={18} /> platform
					</span>
					<span className="landing-platform-note">sessions · timeline · GitHub App · your sign-in, sealed</span>
				</div>

				<article className="landing-place">
					<p className="landing-place-kicker">your machine</p>
					<h3 className="landing-place-title">A runner that connects out</h3>
					<p className="landing-place-text">
						Pair a Linux machine with Docker. A small runner on it dials out to the platform and runs each session in a container there. <strong>Nothing on your machine needs to be reachable from outside.</strong>
					</p>
					<Layers
						layers={[
							{ name: "Docker container", detail: "non-root, no capabilities, seccomp, resource limits" },
							{ name: "Windlass sandbox around each command", detail: "no network, writes only in the workspace, credentials hidden" },
						]}
					/>
					<pre className="landing-command" aria-label="The command that starts the runner">
						<code>
							<span className="landing-prompt">$</span> docker run -d --name windlass-runner \{"\n"}
							{"    "}-v /var/run/docker.sock:/var/run/docker.sock \{"\n"}
							{"    "}-v windlass-runner:/var/lib/windlass-runner \{"\n"}
							{"    "}&lt;runner image&gt; --platform &lt;platform address&gt;
						</code>
					</pre>
				</article>
			</div>
			<p className="landing-note">
				The Windlass sandbox profile is the strict one: a command that wants the network or a write outside the workspace has to ask you first. The hardened profile runs commands directly in the container, with network; the launch form says which promise each profile makes.
			</p>
		</Chapter>
	);
}

/** Containment drawn as the session panel draws it: numbered boxes, each inside the one before. */
function Layers({ layers }: { layers: { name: string; detail: string }[] }) {
	const draw = (index: number): ReactNode => {
		const layer = layers[index];
		if (!layer) return <span className="landing-layer-core">the agent’s commands</span>;
		return (
			<div className="landing-layer">
				<p className="landing-layer-name">
					<span className="landing-layer-n" aria-hidden="true">
						{index + 1}
					</span>
					{layer.name}
				</p>
				<p className="landing-layer-detail">{layer.detail}</p>
				{draw(index + 1)}
			</div>
		);
	};
	return <div className="landing-layers">{draw(0)}</div>;
}

function Factory() {
	return (
		<Chapter
			id="factory"
			number="03"
			eyebrow="Factory"
			title={
				<>
					File the work. <em>Get back a pull request.</em>
				</>
			}
			lede="A work item is a task on one repository that the platform carries from start to pull request by itself. The next step is decided by what the platform observed — checks, CI, the review — never by what the agent says. It never merges: you do."
			wide
		>
			<ol className="landing-steps">
				{FACTORY_STEPS.map((step, index) => (
					<li key={step.label} className={`landing-step${index === FACTORY_STEPS.length - 1 ? " landing-step-last" : ""}`}>
						<span className="landing-step-label">{step.label}</span>
						<span className="landing-step-text">{step.text}</span>
					</li>
				))}
			</ol>
			<FactoryPicture />
		</Chapter>
	);
}

function FactoryPicture() {
	return (
		<figure className="landing-picture pic-factory">
			<div className="pic-window" aria-hidden="true">
				<div className="pic-factory-head">
					<p className="pic-counts">
						12 work items · 3 in progress · <span className="tone-accent">2 ready for you</span> · <span className="tone-info">1 needs you</span>
					</p>
					<p className="pic-factory-title">Factory</p>
				</div>
				<p className="pic-group pic-group-ask">Needs you</p>
				<div className="pic-item">
					<AskIcon size={15} className="tone-info" />
					<div className="pic-item-body">
						<p className="pic-item-title">Stop the import from timing out</p>
						<p className="pic-item-why">The same failure came back after a fix, so the factory stopped instead of trying it again.</p>
						<p className="pic-item-meta">
							<code>your-org/harbor</code> · issue #37
						</p>
					</div>
				</div>
				<p className="pic-group">Ready for you</p>
				<div className="pic-item">
					<PullRequestIcon size={15} className="tone-accent" />
					<div className="pic-item-body">
						<p className="pic-item-title">Add a dark mode to the settings page</p>
						<p className="pic-item-meta">
							<code>your-org/harbor</code> · #52 · <span className="tone-accent">Ready for review</span> · CI passed · reviewed: approves · 3 screenshots
						</p>
					</div>
				</div>
				<div className="pic-item">
					<PullRequestIcon size={15} className="tone-accent" />
					<div className="pic-item-body">
						<p className="pic-item-title">Retry uploads that fail on a dropped connection</p>
						<p className="pic-item-meta">
							<code>your-org/uploader</code> · #18 · <span className="tone-warn">Needs a look</span> · CI passed · reviewed: asks for changes
						</p>
					</div>
				</div>
				<p className="pic-group pic-group-quiet">Done</p>
				<div className="pic-item pic-item-quiet">
					<MergedIcon size={15} />
					<div className="pic-item-body">
						<p className="pic-item-title">Pin the image's base digest</p>
					</div>
				</div>
			</div>
			<figcaption className="landing-caption">The Factory page’s groups, drawn from the app. Illustration with made-up repositories.</figcaption>
		</figure>
	);
}

function Agents() {
	return (
		<Chapter
			id="agents"
			number="04"
			eyebrow="Agents"
			title={
				<>
					Bring the agent <em>you already trust.</em>
				</>
			}
			lede="Windlass is the platform’s own agent: a coding agent for the terminal, built alongside the platform. Claude Code runs on a machine of yours, signed in there. More are on the way."
		>
			<dl className="landing-agents">
				{AGENTS.map((agent) => (
					<div key={agent.name} className={`landing-agent landing-agent-${agent.state}`}>
						<dt className="landing-agent-name">{agent.name}</dt>
						<dd className="landing-agent-state">{agent.state}</dd>
						<dd className="landing-agent-where">{agent.where}</dd>
					</div>
				))}
			</dl>
		</Chapter>
	);
}

function Questions() {
	return (
		<Chapter id="questions" number="05" eyebrow="Questions" title="What people ask first" lede="Short answers. The rest is in the app, which says what each choice promises before you make it.">
			<div className="landing-faq">
				{FAQ.map((item, index) => (
					<details key={item.question} className="landing-faq-item" open={index === 0}>
						<summary className="landing-faq-q">{item.question}</summary>
						<p className="landing-faq-a">{item.answer}</p>
					</details>
				))}
			</div>
		</Chapter>
	);
}

function Closing() {
	return (
		<section className="landing-closing landing-grid" aria-labelledby="closing-title">
			<div className="landing-rail">
				<span className="landing-weight" aria-hidden="true" />
			</div>
			<div className="landing-closing-body">
				<h2 id="closing-title" className="landing-closing-title">
					Hand it the work. <em>Keep your eyes on it.</em>
				</h2>
				<Calls large />
			</div>
		</section>
	);
}

function SiteFoot() {
	return (
		<footer className="landing-foot">
			<div className="landing-foot-inner">
				<span className="wordmark">
					<MarkGlyph size={18} />
					<span className="wordmark-name">windlass</span>
				</span>
				<nav className="landing-foot-nav" aria-label="Site">
					<a href="/signin">Sign in</a>
					<a href="/llms.txt">llms.txt</a>
					<a href="/sitemap.xml">Sitemap</a>
				</nav>
			</div>
		</footer>
	);
}
