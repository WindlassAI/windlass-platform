## Do I need a ChatGPT account?

Yes. You sign in with ChatGPT, and Windlass agents call the model through your ChatGPT account. The models you can choose are the ones your plan offers. Claude Code and OpenCode, on your machines, use the logins you give them there.

## Can I use Claude Code?

Yes, on one of your own machines. Start its runner with `--harness claude`, and sign Claude in on the machine:

```sh
docker exec -it windlass-runner windlass-runner login claude
```

Then choose the machine under **on** and **Claude Code** under **agent**. Claude Code runs with your Claude subscription. See [Agents on your machine](/docs/machines#agents-on-your-machine).

## Can I use OpenCode, or another model provider?

Yes, on one of your own machines. Start its runner with `--harness opencode`, then run `login opencode` on the machine and choose a provider. See [OpenCode](/docs/machines#opencode).

## Which providers work with OpenCode?

OpenCode Go, OpenCode Zen, ChatGPT, OpenAI, Anthropic, Google, OpenRouter, Z.AI, Zhipu AI and close to 300 more, each with its own API key or account. `login opencode` searches them all. Providers the runner has no fixed route for are not offered, for example Amazon Bedrock, Azure, Google Vertex, GitHub Copilot and models on your own computer, such as LM Studio.

## Can I use OpenCode without a provider account?

Yes. Choose `free` in `login opencode` for OpenCode's free public models. Their allowance is small, and OpenCode counts it by your machine's public IP address, so everyone behind that address shares it. When it runs out, the turn says "The provider's usage or rate limit was reached." Wait, or sign in with a provider of your own.

## Where do I sign Claude Code or OpenCode in?

Only in a terminal on the machine, with `windlass-runner login` and the agent's name. The Machines page shows whether each agent is signed in, and the command to copy. See [Sign agents in](/docs/machines#sign-agents-in).

## Which keys stay on my machine?

All of them. Your Claude token, your OpenCode API keys and your ChatGPT login for OpenCode stay in a login volume on the machine, and the runner never sends them to the platform. No agent's container has them either: a relay on the machine adds them to the agent's model requests. Commands in a session can still use that relay, and so your quota. See [Agent logins stay out of the container](/docs/machines#agent-logins-stay-out-of-the-container).

## Does the agent get my ChatGPT password or sign-in?

No. Your ChatGPT sign-in is never in a sandbox. A Windlass turn using your ChatGPT plan gets an access token after setup. Each token lasts about an hour from issue. Unsandboxed commands and approved local MCP servers can read it, including replacements during that turn. Windlass hides the file from sandboxed commands. See [Sandboxes and security](/docs/security).

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

The Apache License 2.0, for all of it: the runner, the sandbox images, the server, the web app, the Factory and the deployment kit. You may use, change, self-host and redistribute it, including commercially. It also grants a license to any patents contributors hold on their contributions. See the repository's [LICENSE](https://github.com/WindlassAI/windlass-platform/blob/main/LICENSE).

## Where do I report a problem?

Ask whoever runs the platform. Give them the address of the agent or work item, and the message you saw.
