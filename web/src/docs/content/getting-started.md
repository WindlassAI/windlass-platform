## Get access

The platform is by invitation for now. Whoever runs it keeps a list of the accounts that may sign in. Ask them to add the email address of your ChatGPT account.

If your account is not on the list, the sign-in ends with this message:

> This platform is by invitation for now, and this ChatGPT account is not on its list. Ask whoever runs it to add you.

The list is checked each time you use the platform, not only at sign-in. If you are taken off it, you are signed out.

## Sign in with ChatGPT

Agents call the model through your ChatGPT account, so you sign in with it. The sign-in has two steps, and you have 10 minutes for them. A timer on the page shows the time left.

1. Open the sign-in page, choose **Continue with ChatGPT**, then **Open the sign-in page**. OpenAI's page opens in a new tab. Approve the sign-in there.
2. After you approve, the browser goes to a page at `http://127.0.0.1:1455/auth/callback` that fails to load. That is expected. Copy that page's full address from the address bar.
3. Back on Windlass, paste it into **Address of the page that did not load**, then choose **Finish signing in**.

If the time runs out, the page says "This attempt has run out of time." Choose **Start over** for a new attempt.

> **Note** The address you paste must start with `http://127.0.0.1:1455/auth/callback?code=`. If it does not, the platform says "That is not the address the browser ended on."

### Your ChatGPT connection

Open the account menu, at the top right, to see the connection. It says **ChatGPT connected**, with your email. ChatGPT access tokens last about an hour. The platform renews them for you, so each turn of an agent gets a fresh one. You do not need to sign in again while you use the platform.

### The demo

Some deployments offer a demo. The sign-in page then shows **Try the demo**. The demo runs a scripted model with real tool calls and needs no account.

### Sign out

Open the account menu and choose **Sign out**. This signs you out in this browser.

## Connect GitHub

Connect GitHub to launch agents on your own repositories, private ones included, and to get their work back as pull requests. Without it, an agent can still clone a public repository by its address, or start in an empty one.

1. Open the account menu and choose **Connect GitHub**.
2. Authorize the Windlass GitHub App at GitHub.
3. If the App is not installed on your account yet, GitHub shows its installation page. Choose the account and the repositories the App may see.

When you are back, the menu says **GitHub connected** and lists the accounts the connection covers. Organizations are marked **organization**.

- To choose which repositories the App may see, follow the **repositories** link beside an account. It opens that installation's settings at GitHub.
- To add another account or organization, choose **Add an account**.
- To remove the connection from Windlass, choose **Disconnect**. The App stays installed at GitHub. Only the account's owner can uninstall it there.

> **Note** If you ask an organization to install the App, one of its owners has to approve the request at GitHub first. Connect GitHub again once it is installed.

### What the GitHub App may do

The platform acts as the App's installation. It keeps no GitHub token of yours. The App asks for these permissions, and nothing else:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Clone the repository, and push the agent's branch. |
| Pull requests | Read and write | Open and update the pull request. |
| Checks | Read-only | Read CI on a work item's pull request. |
| Commit statuses | Read-only | Read CI on a work item's pull request. |
| Actions | Read-only | Read CI on a work item's pull request. |
| Metadata | Read-only | GitHub adds it to every App. |

The three read-only CI permissions are used only by work items. Everything else works without them.

Each token the platform makes for a clone or a push covers one repository and lasts an hour at most. It is given only to that one git command, and it is revoked when the command ends. The agent's sandbox is never given your GitHub access.

The App does not ask for the Workflows permission. So GitHub refuses a push that changes a file under `.github/workflows`. Take such a change out, or make it yourself.

## Start your first agent

1. Go to **Agents**, the home page.
2. Type what the agent should do in **What should it do?**
3. Under the field, choose the repository under **repo**. Leave the other choices as they are for now.
4. Press <kbd>Enter</kbd>, or choose **Launch**.

The platform creates the agent, makes its sandbox, clones the repository and sends your prompt. The agent's page opens and shows its work as it happens.

Next: [Start an agent](/docs/start-an-agent) explains every choice under the field.
