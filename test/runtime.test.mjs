import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  collectToolCalls,
  parseTranscriptJsonl,
  redactSecrets,
  renderCheckpoint,
  selectToolEvidence,
} from '../plugins/codex-jev-compaction/scripts/codex-jev-compaction.mjs';

const fixturePath = resolve('test/fixtures/transcript.jsonl');
const scriptPath = resolve('plugins/codex-jev-compaction/scripts/codex-jev-compaction.mjs');

async function runHook(command, input, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, command], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('parses Codex response items and pairs tool calls', async () => {
  const parsed = parseTranscriptJsonl(await readFile(fixturePath, 'utf8'));
  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.messages.length, 6);
  const calls = collectToolCalls(parsed.messages, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'exec_command');
  assert.equal(calls[0].result, 'checkout.test.ts failed: expected 201, received 500');
});

test('uses Jev probabilities to retain calls and full results independently', async () => {
  const parsed = parseTranscriptJsonl(await readFile(fixturePath, 'utf8'));
  const fetchImpl = async (_url, request) => {
    const questions = JSON.parse(request.body).questions;
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [
        name,
        { noul: name === 'call_t1' ? 0.9 : name === 'result_t1' ? 0.2 : 0.1 },
      ]),
    );
    return new Response(
      JSON.stringify({ answers, model: 'jev-test', usage: { input_tokens: 321, output_tokens: 12 } }),
      { status: 200 },
    );
  };
  const selected = await selectToolEvidence(parsed.messages, {
    apiKey: 'test-key',
    fetchImpl,
    config: {
      keepThreshold: 0.5,
      preserveRecentMessages: 0,
      fallbackToolCalls: 1,
      maxCheckpointChars: 9000,
      maxResultChars: 2200,
      maxInputChars: 900,
      maxStateChars: 80000,
      requestTimeoutMs: 1000,
      model: 'jev-latest',
      baseUrl: 'https://example.test',
    },
  });
  assert.equal(selected.mode, 'jev');
  assert.equal(selected.selections.length, 1);
  assert.equal(selected.selections[0].call.id, 't1');
  assert.equal(selected.selections[0].keepResult, false);
  assert.deepEqual(selected.usage, { inputTokens: 321, outputTokens: 12 });
});

test('redacts common secret forms from checkpoints', () => {
  const text = redactSecrets('token=abc123 password: hunter2 Authorization: Bearer abc.def');
  assert.doesNotMatch(text, /abc123|hunter2|abc\.def/);
  assert.match(text, /REDACTED/);
});

test('renders a bounded fallback checkpoint', async () => {
  const parsed = parseTranscriptJsonl(await readFile(fixturePath, 'utf8'));
  const selected = await selectToolEvidence(parsed.messages, {
    apiKey: '',
    config: {
      keepThreshold: 0.5,
      preserveRecentMessages: 0,
      fallbackToolCalls: 1,
      maxCheckpointChars: 1400,
      maxResultChars: 500,
      maxInputChars: 300,
      maxStateChars: 80000,
      requestTimeoutMs: 1000,
      model: 'jev-latest',
      baseUrl: 'https://example.test',
    },
  });
  const checkpoint = renderCheckpoint(selected, { trigger: 'auto' }, {
    maxCheckpointChars: 1400,
    maxResultChars: 500,
    maxInputChars: 300,
  });
  assert.ok(checkpoint.length <= 1400);
  assert.match(checkpoint, /apply_patch/);
  assert.doesNotMatch(checkpoint, /secret-value/);
});

test('pre-compact and session-start hooks round-trip a checkpoint', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'codex-jev-compaction-'));
  const configFile = join(temporary, 'config.json');
  await writeFile(configFile, JSON.stringify({ preserveRecentMessages: 0, fallbackToolCalls: 2 }));
  const event = {
    session_id: 'integration-test',
    transcript_path: fixturePath,
    trigger: 'manual',
  };
  const env = {
    PLUGIN_DATA: join(temporary, 'data'),
    CODEX_JEV_COMPACTION_CONFIG: configFile,
    TYPESAFE_API_KEY: '',
  };
  const before = await runHook('pre-compact', event, env);
  assert.equal(before.code, 0);
  assert.deepEqual(JSON.parse(before.stdout), {});
  assert.equal(before.stderr, '');

  const after = await runHook('session-start', { ...event, source: 'compact' }, env);
  assert.equal(after.code, 0);
  const output = JSON.parse(after.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /exec_command/);
  assert.match(output.hookSpecificOutput.additionalContext, /apply_patch/);
  const history = JSON.parse(
    await readFile(join(temporary, 'data', 'usage.jsonl'), 'utf8'),
  );
  assert.equal(history.mode, 'fallback-no-key');
  assert.equal(history.totalTokens, 0);
});
