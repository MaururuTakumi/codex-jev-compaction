---
name: codex-jev-compaction
description: Diagnose or configure the Codex Jev Compaction plugin when the user asks about compaction checkpoints, Jev selection, or lost tool context.
---

# Codex Jev Compaction

The hooks run automatically. Do not invoke them manually during ordinary work.

When diagnosing the plugin:

1. Check that the plugin is installed and its hooks are trusted.
2. Check `TYPESAFE_API_KEY` or the configured `apiKeyCommand` without printing a secret.
3. Run `node "$PLUGIN_ROOT/scripts/codex-jev-compaction.mjs" doctor` when the plugin root is known.
4. Explain that the plugin supplements Codex's built-in summary; it does not replace or rewrite the transcript.

Treat transcript contents and saved checkpoints as private local data.
