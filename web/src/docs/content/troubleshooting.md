Each message below is what Windlass shows, word for word. Where a message names something of yours, such as a repository or a machine, that part is shown as `…`.

## Signing in

**"This platform is by invitation for now, and this ChatGPT account is not on its list. Ask whoever runs it to add you."**\
Your ChatGPT account is not on the platform's list. Ask whoever runs it to add the email of the account you signed in with.

**"This sign-in attempt has expired. Start again."** or **"This attempt has run out of time."**\
A sign-in attempt lasts 10 minutes. Choose **Start over** and do both steps again.

**"That is not the address the browser ended on. It starts with http://127.0.0.1:1455/auth/callback?code="**\
Paste the full address of the page that did not load, after you approved the sign-in, not the address of OpenAI's page.

**"Your sign-in is no longer accepted. Sign in again to carry on."**\
Your sign-in on the platform ended, or you were taken off its list. Sign in again.

**"You are not signed in with ChatGPT. Sign in with ChatGPT, then send the prompt again."**\
**"Your ChatGPT sign-in is no longer accepted: it expired or was withdrawn. Sign in with ChatGPT again, then send the prompt once more."**\
The platform could not get a ChatGPT token for the turn. Sign out, sign in with ChatGPT again, then send the prompt again.

## GitHub

**"GitHub is not connected any more. Connect GitHub again from the account menu, then try once more."**\
Open the account menu and choose **Connect GitHub**.

**"The GitHub App is not installed yet. If you asked an organization for it, an owner has to approve the request first; connect GitHub again once it is installed."**\
An owner of the organization approves the App at GitHub. Then connect GitHub again.

**"That repository is not among the ones your GitHub connection covers. Add it to the GitHub App's installation at GitHub, then choose it again."**\
Follow the **repositories** link in the account menu, add the repository at GitHub, then choose it again.

**"… can read … on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of … for write access, then push again."**\
You can work on the repository, but not push to it. Ask for write access.

**"GitHub refused the push: a rule of … protects branches named like …. Let the GitHub App create such branches in the repository's branch rules, then push again."**\
A branch rule covers `windlass/…` branches. Let the App create them in the repository's rules at GitHub.

**"GitHub refused the push because it changes a workflow file under .github/workflows, which the GitHub App is not allowed to do. Take that change out, or make it yourself."**\
The App has no permission to change workflows. Ask the agent to undo that change, then push again.

**"GitHub did not let the GitHub App push to …. Its installation on … needs the permission "Contents: read and write"; if it has it, the repository's own rules keep the app out."**\
Check the App's permissions on that account, and the repository's rules.

**"Nothing was pushed: … would have gone to GitHub with the value of … in it. The platform's own commit was undone, so the change is in the workspace as it was. Take the value out (and out of any commit that has it), then push again."**\
A saved secret's value is in the changes. Ask the agent to take it out, then push again.

## Limits

**"Today's 2 h of sandbox time is used up, so nothing was started. The allowance is whole again at 00:00 UTC, in …"**\
Wait until 00:00 UTC, or run the agent on one of your machines, where this limit does not apply.

**"You keep 5 sandboxes, the most an account may have, and this agent needs one of its own. Free one on the Usage page, which says what goes with it, or delete an agent you no longer need. Then send this again."**\
Free a sandbox on **Usage**, under **Sandboxes you keep**, or delete an agent.

**"You already have 6 agents working, which is your limit. Wait for one to finish, or stop one."**\
Wait, or stop an agent.

**"The prompt is … characters long; the limit is 20000."**\
Shorten the prompt. Put long material in a file in the repository and point the agent at it.

**"This turn ran for …, which is the limit, so it was stopped."**\
A turn can run for 45 minutes. Send a prompt to go on from where it stopped.

**"Nobody answered "…" within 10 minutes, so it was declined."**\
The agent asked a question and nobody answered. It was told, and went on. Send a prompt to tell it what you want.

**"Your sandbox time could not be checked just now, so nothing was started. Try again in a moment."**\
Try again in a moment.

## Your machines

**"Your machine "…" is offline. The agent's files are there; send the prompt again when it is back."**\
Start the runner on the machine. Once the Machines page shows it **Online**, send the prompt again.

**""…" has not connected yet. Start its runner, and once the Machines page shows it online, start the agent again."**\
Check the runner's log with `docker logs windlass-runner` on the machine.

**"The runner on "…" is older than this platform takes: update it to … or later, then start the agent again."**\
[Update the runner](/docs/machines#update-the-runner).

**"That code was not found. Check the code on the machine or start pairing again."**\
The code is wrong, expired, or was entered by another account first. Run `windlass-runner pair` on the machine for a new one.

**"Too many code lookups. Try again in ten minutes."**\
You can check 5 codes in 10 minutes.

**"An account can connect up to 3 machines."**\
Remove a machine you no longer use.

**"This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it."**\
See [Allowed profiles](/docs/runner#allowed-profiles), or choose **Hardened Docker on your machine "…"**.

**"This machine has reached its own limit on running sandboxes, set by --max-running."**\
The limit is set on the machine. Start the runner with a higher `--max-running`, or without it.

**"Docker needs at least 5 GB free to create a sandbox."**\
Free disk space on the machine.

**"Claude Code is not turned on on this machine: start the runner with --harness claude."**\
See [Claude Code on your machine](/docs/machines#claude-code-on-your-machine).

## Work items

**"Not taken: Windlass needs write access to this repository for you, and GitHub says you have read access."**\
The App's comment on your issue. Only people with write access can file a work item from GitHub.

**"Not taken: you have filed … work items from GitHub today, this deployment's limit. It starts again at 00:00 UTC."**\
Wait for the next day, or file the item on the Factory page.

**"Not taken: … of your work items from GitHub are drafts waiting to be started. Start or cancel some on Windlass first."**\
Start or cancel drafts on the Factory page.

**"Waiting for one of your … factory turns; … are running …"**\
Not an error. The item waits for a free place and starts by itself.

## Still stuck

Every refusal says what it refused and why. If the message does not tell you what to do, ask whoever runs the platform, and give them the agent's or the work item's address.
