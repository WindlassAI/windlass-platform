/**
 * The flags every git of the platform's in a session's sandbox runs with (git.ts), and the workspace's
 * first commit. Apart from git.ts so that the sandbox providers, which the runner bundles, can use them.
 */

/**
 * What every git the platform runs in the workspace is given on its command line, whatever any
 * configuration says (the command line wins over every file): no hooks, no file-system monitor, no
 * recursion into submodules, no automatic housekeeping, no SSH program, no attributes file of a home,
 * and no transport but HTTP(S). Each of those would start a program a configuration names. Filters and
 * diff or merge drivers have names of the repository's choosing, so no flag can unset them: they are
 * defined only in configuration, and platform git reads none that a setup or an agent writes (`GIT_ENV`
 * leaves out the system's and the home's, and the workspace's `.git/config` is only screened, as data,
 * by `wlp_guard`, which refuses one that defines any). `TRANSPORT_FLAGS` is these without the reset of
 * the credential helpers, which `tokenGit` sets.
 */
export const TRANSPORT_FLAGS = [
	"-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c gc.auto=0 -c maintenance.auto=false",
	"-c core.sshCommand=/bin/false -c core.attributesFile=/dev/null",
	"-c protocol.allow=never -c protocol.https.allow=always -c protocol.http.allow=always",
].join(" ");
export const SAFE_FLAGS = TRANSPORT_FLAGS + " -c credential.helper=";

/**
 * The empty repository and first commit of a new sandbox's workspace, as its user, in the workspace.
 * It runs before any setup, but with the user's home: one a volume or a prepared image carried over
 * can hold a `~/.gitconfig` a setup wrote. So it reads no configuration of the home's or the system's;
 * what the image's `~/.gitconfig` gave it (the branch, the author) is said here.
 */
export const INIT_WORKSPACE = "(export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null; git init -q -b main && " +
	`git ${SAFE_FLAGS} -c commit.gpgSign=false -c user.name='Windlass agent' -c user.email=agent@windlass-platform.invalid commit -q --no-verify --allow-empty -m 'Empty workspace')`;
