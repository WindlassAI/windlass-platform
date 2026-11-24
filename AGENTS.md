Make the smallest change that solves the task.
Write readable code. Reuse existing code instead of copying it.
Skip compatibility code for old or stored data. Avoid extra fallbacks.

Keep comments short and explain why. Skip comments that restate the code and long prose blocks.

Run the typecheck, then only the check files or cases your change touches, one at a time.
Full suites run in CI.

Never edit README.md. Put behaviour documentation in web/src/docs/content/*.md.
