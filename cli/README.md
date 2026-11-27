# @windlassai/cli

Connects what you have on your own computer to Windlass. Today: your Claude Pro or Max plan.

```sh
npx @windlassai/cli connect claude
```

1. The command shows a code like `KQ2M-8XF4` and opens the platform's connect page in your browser.
2. Sign in there if needed, check that the page shows the same code, and choose **Approve**.
3. The command then runs `claude setup-token` (through `npx @anthropic-ai/claude-code` when Claude Code is not
   installed). Sign in to Claude when it asks. The command reads the token off that screen and hands it to
   your account, which checks it with Anthropic and keeps it encrypted.

The CLI never prints, logs or saves the token. If it cannot read the token from the screen, it asks you to paste
it (hidden). To pass a token you already have: `npx @windlassai/cli connect claude --token-stdin < token.txt`.

## Options

- `--platform <url>` or `WINDLASS_PLATFORM`: a self-hosted platform (default `https://windlass.parthg.dev`).
- `--no-browser`: print the connect page's address instead of opening it.
- `--token-stdin`: read the setup token from standard input instead of running `claude setup-token`.

Needs Node.js 18 or later. On Linux and macOS, `claude setup-token` runs under `script`, a pseudo-terminal, so
the token can be read from its output; elsewhere you paste it.
