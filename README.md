# Codex Jev Compaction

A Codex plugin that preserves high-value tool evidence across context compaction with [TypeSafe Jev](https://typesafe.ai/).

Codex already creates its own compacted summary. This plugin supplements that summary:

1. `PreCompact` reads the local Codex JSONL transcript.
2. Jev decides which completed tool calls and exact results still matter.
3. The plugin writes a bounded, private checkpoint outside the transcript.
4. `SessionStart` with `source: compact` restores the checkpoint before the immediate continuation.

It never rewrites the Codex transcript and fails open. If Jev or credentials are unavailable, it falls back to recent/error tool evidence so compaction can continue.

## Requirements

- Codex with [hooks support](https://developers.openai.com/ja-JP/docs/hooks)
- Node.js 20 or newer
- A TypeSafe API key for Jev selection (optional; fallback mode works without one)

## Install

```bash
codex plugin marketplace add MaururuTakumi/codex-jev-compaction
codex plugin add codex-jev-compaction@codex-jev-compaction
```

Review and trust the plugin hooks when Codex prompts you. Restart Codex if the plugin does not appear immediately.

## Configure credentials

Use an environment variable:

```bash
export TYPESAFE_API_KEY="..."
```

Or create `~/.config/codex-jev-compaction/config.json` with a command that prints the key to stdout:

```json
{
  "apiKeyCommand": ["security", "find-generic-password", "-w", "-s", "typesafe-jev"]
}
```

The command runs without a shell. Its output is held in memory and is never written to the checkpoint or logs.

Optional settings:

```json
{
  "keepThreshold": 0.5,
  "preserveRecentMessages": 6,
  "fallbackToolCalls": 12,
  "maxCheckpointChars": 9000,
  "maxResultChars": 2200,
  "maxInputChars": 900,
  "model": "jev-latest"
}
```

Run the local diagnostic without revealing the key:

```bash
node /path/to/plugin/scripts/codex-jev-compaction.mjs doctor
```

Inspect the latest compaction runs and Jev token usage:

```bash
node /path/to/plugin/scripts/codex-jev-compaction.mjs history
```

The local `usage.jsonl` history contains timestamps, mode, request and token counts, retained call counts, and checkpoint size. It never stores the API key, prompts, tool inputs, or tool results.
Outside a hook, the command reads Codex's standard plugin data directory automatically.

## Privacy and limits

- Jev receives a compact history containing user/assistant text, tool names, and tool inputs. Tool results are omitted from the Jev request; only their status and character counts are included.
- Selected tool inputs/results are stored locally in the plugin data directory with owner-only permissions.
- Common secret patterns are redacted, but redaction is not a security boundary. Avoid placing secrets in prompts or tool output.
- Codex's transcript format is not a stable public API. Unknown records are ignored and malformed lines do not block compaction.
- The checkpoint is intentionally bounded and expires after 30 minutes by default.

## Development

```bash
npm install
npm test
npm run validate
```

Validate the plugin manifest with the Codex plugin creator validator before release.

## Why this differs from fast-jev-compaction

[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) can return a replacement message history to Claude Code. Codex hooks do not expose transcript replacement. This plugin instead uses the supported `PreCompact` and post-compaction `SessionStart` lifecycle to checkpoint and restore selected evidence.

## License

MIT. See `NOTICE` for upstream inspiration and attribution.

---

## 日本語

Codex標準の要約を置き換えず、圧縮前にJevで重要なツール実行結果を選別し、圧縮直後の継続へ補助コンテキストとして戻すプラグインです。Jevが使えない場合も直近・エラーのツール証拠を残すフォールバックで動作します。
