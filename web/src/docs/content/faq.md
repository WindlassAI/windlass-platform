## Do I need a ChatGPT account?

Yes. You sign in with ChatGPT, and Windlass agents call the model through your ChatGPT account. The models you can choose are the ones your plan offers.

## Can I use Claude Code?

Yes, on one of your own machines. Start its runner with `--harness claude`, sign Claude in from the Machines page, then choose the machine under **on** and **Claude Code** under **agent**. Claude Code runs with your Claude subscription. See [Claude Code on your machine](/docs/machines#claude-code-on-your-machine).

## Does the agent get my ChatGPT password or sign-in?

No. Your ChatGPT sign-in is never in a sandbox. Each turn gets a short-lived access token, which lasts about an hour and cannot be renewed. In some sandboxes the agent's commands can read that token. See [Sandboxes and security](/docs/security).

## Does the agent get my GitHub access?

No. The platform does the clone and the push itself, with a token for that one repository that lasts an hour at most and is revoked when the command ends.

## Does Windlass merge pull requests?

No. Merging always stays yours.

## Can I run agents on a private repository?

Yes. Connect GitHub and give the Windlass App access to the repository at GitHub.

## Can I attach files to a prompt?

No. Put the material in the repository, or paste it into the prompt, up to 20,000 characters.

## What happens when I close the tab?

Nothing stops. The agent keeps working in its sandbox. Open the agent's page again to see where it is. If it asks a question while nobody answers, the question is declined after 10 minutes.

## How do I continue an agent that finished?

Send it another prompt. It goes on with the same conversation and, while it still exists, the same sandbox.

## Why did my sandbox get paused?

A sandbox is paused 10 minutes after its last turn, so it uses no sandbox time. The next prompt wakes it up. On this platform, a sandbox not used for 7 days is removed. The conversation stays.

## Is my own machine counted against my sandbox time?

No. Agents on your machines take no sandbox time, no place among your kept sandboxes and no place among your agents working at once. Only the limits you set with the runner apply.

## What does the platform see on my machine?

What its runner reports: whether Docker answers, whether Windlass's sandbox starts there, the free disk, its sandboxes and the limits you set. And what happens inside the containers the runner made for the platform's agents. It cannot run anything on the machine outside those containers. See [On your machine](/docs/security#on-your-machine).

## Can I read a secret's value back?

No. A saved value is never shown again. Keep your own copy.

## Can I run my own platform?

Yes. The platform runs on one Linux host with Docker Compose. The [self-host guide](https://github.com/WindlassAI/windlass-platform/blob/main/deploy/selfhost/README.md) is written for whoever runs it: how to bring the stack up, route it, back it up and update it. Agents never run on the platform host itself. Pair a machine of yours, or use hosted sandboxes, for them.

## What license is the code under?

Two licenses, split by where the code runs:

- **MIT** for the code that runs on your machine: the runner, the sandbox images and helpers, and the protocol and sandbox layer they share with the server.
- **FSL-1.1-MIT** for everything else: the server, the web app, the Factory, the deployment kit and the scripts. You may read, use, change and self-host it for yourself or your organization. You may not offer it as a competing commercial product or service. Each version becomes MIT two years after it is released.

The repository's [NOTICE.md](https://github.com/WindlassAI/windlass-platform/blob/main/NOTICE.md) lists which paths are which. The license texts decide, not this summary.

## Where do I report a problem?

Ask whoever runs the platform. Give them the address of the agent or work item, and the message you saw.
