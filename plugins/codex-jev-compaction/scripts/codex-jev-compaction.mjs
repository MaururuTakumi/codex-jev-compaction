#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_CONFIG = Object.freeze({
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  fallbackToolCalls: 12,
  maxCheckpointChars: 9000,
  maxResultChars: 2200,
  maxInputChars: 900,
  maxStateChars: 80000,
  maxTranscriptBytes: 64 * 1024 * 1024,
  checkpointMaxAgeMinutes: 30,
  requestTimeoutMs: 20000,
  model: DEFAULT_MODEL,
  baseUrl: SYSTEM_ONE_URL,
});

function finiteNumber(value, fallback, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, value)
    : fallback;
}

function resolveConfig(raw = {}) {
  return {
    keepThreshold: finiteNumber(raw.keepThreshold, DEFAULT_CONFIG.keepThreshold),
    preserveRecentMessages: Math.floor(
      finiteNumber(raw.preserveRecentMessages, DEFAULT_CONFIG.preserveRecentMessages),
    ),
    fallbackToolCalls: Math.floor(
      finiteNumber(raw.fallbackToolCalls, DEFAULT_CONFIG.fallbackToolCalls),
    ),
    maxCheckpointChars: Math.floor(
      finiteNumber(raw.maxCheckpointChars, DEFAULT_CONFIG.maxCheckpointChars, 1000),
    ),
    maxResultChars: Math.floor(
      finiteNumber(raw.maxResultChars, DEFAULT_CONFIG.maxResultChars, 100),
    ),
    maxInputChars: Math.floor(
      finiteNumber(raw.maxInputChars, DEFAULT_CONFIG.maxInputChars, 100),
    ),
    maxStateChars: Math.floor(
      finiteNumber(raw.maxStateChars, DEFAULT_CONFIG.maxStateChars, 5000),
    ),
    maxTranscriptBytes: Math.floor(
      finiteNumber(raw.maxTranscriptBytes, DEFAULT_CONFIG.maxTranscriptBytes, 1024),
    ),
    checkpointMaxAgeMinutes: finiteNumber(
      raw.checkpointMaxAgeMinutes,
      DEFAULT_CONFIG.checkpointMaxAgeMinutes,
      1,
    ),
    requestTimeoutMs: Math.floor(
      finiteNumber(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000),
    ),
    model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_CONFIG.model,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_CONFIG.baseUrl,
    apiKeyCommand: Array.isArray(raw.apiKeyCommand)
      ? raw.apiKeyCommand.filter((part) => typeof part === 'string')
      : undefined,
  };
}

function configPath() {
  if (process.env.CODEX_JEV_COMPACTION_CONFIG) {
    return resolve(process.env.CODEX_JEV_COMPACTION_CONFIG);
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'codex-jev-compaction', 'config.json');
}

export async function loadConfig() {
  try {
    return resolveConfig(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return resolveConfig();
    throw new Error(`Invalid config at ${configPath()}: ${error.message}`);
  }
}

export async function resolveApiKey(config) {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  if (!config.apiKeyCommand?.length) return '';
  const [command, ...args] = config.apiKeyCommand;
  if (!command) return '';
  const { stdout } = await execFileAsync(command, args, {
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  return stdout.trim();
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable value]';
  }
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return { value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.output_text === 'string') return part.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function parseTranscriptJsonl(jsonl) {
  const messages = [];
  let malformedLines = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (event?.type !== 'response_item' || !event.payload || typeof event.payload !== 'object') {
      continue;
    }
    const payload = event.payload;
    if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      messages.push({
        role: payload.role,
        text: contentText(payload.content),
        toolUses: [],
        toolResults: [],
      });
      continue;
    }
    if (payload.type === 'function_call') {
      const toolUseId = String(payload.call_id || payload.id || `call-${messages.length + 1}`);
      messages.push({
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: toolUseId,
            tool: String(payload.name || 'unknown_tool'),
            input: parseArguments(payload.arguments),
          },
        ],
        toolResults: [],
      });
      continue;
    }
    if (payload.type === 'function_call_output') {
      const toolUseId = String(payload.call_id || payload.id || `result-${messages.length + 1}`);
      messages.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          {
            tool_use_id: toolUseId,
            text: stringify(payload.output ?? ''),
            isError: Boolean(payload.is_error || payload.isError),
          },
        ],
      });
    }
  }
  return { messages, malformedLines };
}

export function collectToolCalls(messages, preserveRecentMessages = 6) {
  const results = new Map();
  messages.forEach((message, index) => {
    for (const result of message.toolResults || []) {
      results.set(result.tool_use_id, { result, resultIndex: index });
    }
  });
  const calls = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses || []) {
      const paired = results.get(tool.tool_use_id);
      if (!paired) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        toolUseId: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        result: paired.result.text,
        isError: paired.result.isError,
        callIndex,
        resultIndex: paired.resultIndex,
        pinned:
          callIndex >= messages.length - preserveRecentMessages ||
          paired.resultIndex >= messages.length - preserveRecentMessages,
      });
    }
  });
  return calls;
}

function truncate(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 28))}\n[… ${value.length - limit} chars omitted …]`;
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, '$1-[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
      '$1[REDACTED]',
    );
}

function buildState(messages, calls, config) {
  const byCallIndex = new Map();
  for (const call of calls) {
    const list = byCallIndex.get(call.callIndex) || [];
    list.push(call);
    byCallIndex.set(call.callIndex, list);
  }
  const goal = messages
    .filter((message) => message.role === 'user' && message.text.trim() && !message.toolResults.length)
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
  let history = messages.map((message, index) => {
    const entry = {
      i: index,
      role: message.role,
      text: truncate(message.text, 900),
    };
    const ownCalls = (byCallIndex.get(index) || []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: truncate(stringify(call.input), 500),
      result: `${call.isError ? 'error' : 'ok'}, ${call.result.length} chars (omitted)`,
    }));
    if (ownCalls.length) entry.tool_calls = ownCalls;
    return entry;
  });
  const state = () => ({
    context:
      'A Codex coding conversation is about to be compacted. Select tool evidence that remains necessary for the next model request. Re-runnable discovery output is less valuable than decisions, exact identifiers, errors, patches, and verification evidence.',
    goal,
    history,
  });
  if (JSON.stringify(state()).length <= config.maxStateChars) return state();
  history = history.map((entry, index) =>
    index < history.length - config.preserveRecentMessages
      ? {
          ...entry,
          text: entry.text ? `[… ${entry.text.length} chars omitted …]` : '',
          tool_calls: entry.tool_calls?.map((call) => ({
            ...call,
            input: truncate(call.input, 120),
          })),
        }
      : entry,
  );
  while (JSON.stringify(state()).length > config.maxStateChars && history.length > 1) {
    history.shift();
  }
  return state();
}

function questionsFor(calls) {
  return Object.assign(
    {},
    ...calls.map((call) => ({
      [`call_${call.id}`]: {
        type: 'noul',
        instructions: `Tool call ${call.id} (${call.tool}) should be restored after Codex compaction because knowing the call and input still matters for the ongoing task`,
      },
      [`result_${call.id}`]: {
        type: 'noul',
        instructions: `The output of tool call ${call.id} (${call.tool}, ${call.result.length} chars) contains exact evidence that should be restored after Codex compaction rather than re-created or summarized`,
      },
    })),
  );
}

async function askJev(state, questions, apiKey, config, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchImpl(config.baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Jev request failed (${response.status}): ${text.slice(0, 160)}`);
    const parsed = JSON.parse(text);
    if (!parsed?.answers || typeof parsed.answers !== 'object') {
      throw new Error('Jev response is missing answers');
    }
    return {
      answers: parsed.answers,
      model: typeof parsed.model === 'string' ? parsed.model : config.model,
      usage: {
        inputTokens: finiteNumber(parsed.usage?.input_tokens, 0),
        outputTokens: finiteNumber(parsed.usage?.output_tokens, 0),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function probability(answers, name) {
  const value = answers?.[name]?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return value;
}

export async function selectToolEvidence(
  messages,
  { config = resolveConfig(), apiKey = '', fetchImpl = fetch } = {},
) {
  const calls = collectToolCalls(messages, config.preserveRecentMessages);
  if (!calls.length) {
    return {
      selections: [],
      mode: 'empty',
      calls: 0,
      requests: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  if (!apiKey) {
    const selectedIds = new Set(
      calls
        .filter((call) => call.isError || call.pinned)
        .concat(calls.slice(-config.fallbackToolCalls))
        .map((call) => call.id),
    );
    return {
      selections: calls
        .filter((call) => selectedIds.has(call.id))
        .map((call) => ({ call, keepResult: true, score: call.pinned ? 1 : 0.75 })),
      mode: 'fallback-no-key',
      calls: calls.length,
      requests: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const candidates = calls.filter((call) => !call.pinned);
  const answers = {};
  let requests = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const state = buildState(messages, calls, config);
  for (let index = 0; index < candidates.length; index += 24) {
    const batch = candidates.slice(index, index + 24);
    const response = await askJev(state, questionsFor(batch), apiKey, config, fetchImpl);
    Object.assign(answers, response.answers);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    requests += 1;
  }
  const selections = [];
  for (const call of calls) {
    if (call.pinned) {
      selections.push({ call, keepResult: true, score: 1 });
      continue;
    }
    const keepCall = probability(answers, `call_${call.id}`);
    const keepResult = probability(answers, `result_${call.id}`);
    if (keepResult >= config.keepThreshold) {
      selections.push({ call, keepResult: true, score: keepResult });
    } else if (keepCall >= config.keepThreshold) {
      selections.push({ call, keepResult: false, score: keepCall });
    }
  }
  return { selections, mode: 'jev', calls: calls.length, requests, usage };
}

function renderSelection(selection, config) {
  const { call, keepResult } = selection;
  const lines = [
    `### ${call.id} · ${call.tool}${call.isError ? ' · ERROR' : ''}`,
    `Input: ${truncate(redactSecrets(stringify(call.input)), config.maxInputChars)}`,
  ];
  if (keepResult) {
    lines.push(`Result:\n${truncate(redactSecrets(call.result), config.maxResultChars)}`);
  } else {
    lines.push(`Result omitted by Jev (${call.result.length} chars); re-run the tool if needed.`);
  }
  return lines.join('\n');
}

export function renderCheckpoint(selectionResult, event, config = resolveConfig()) {
  const header = [
    '# Codex Jev compaction checkpoint',
    '',
    'This is a bounded supplement to Codex\'s built-in compacted summary. Re-verify stale facts and re-run tools when practical.',
    `Selection: ${selectionResult.mode}; retained ${selectionResult.selections.length}/${selectionResult.calls} completed tool calls; trigger ${event.trigger || 'unknown'}.`,
    '',
  ].join('\n');
  const ranked = [...selectionResult.selections].sort((left, right) => {
    if (right.call.pinned !== left.call.pinned) return Number(right.call.pinned) - Number(left.call.pinned);
    if (right.score !== left.score) return right.score - left.score;
    return right.call.callIndex - left.call.callIndex;
  });
  const kept = [];
  let used = header.length;
  for (const selection of ranked) {
    const block = renderSelection(selection, config);
    if (used + block.length + 2 > config.maxCheckpointChars) continue;
    kept.push(selection);
    used += block.length + 2;
  }
  kept.sort((left, right) => left.call.callIndex - right.call.callIndex);
  const body = kept.map((selection) => renderSelection(selection, config)).join('\n\n');
  return truncate(`${header}${body || 'No tool evidence required restoration.'}`, config.maxCheckpointChars);
}

function dataDirectory() {
  return (
    process.env.PLUGIN_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugin-data', 'codex-jev-compaction')
  );
}

function sessionKey(event) {
  const source = String(event.session_id || basename(event.transcript_path || 'unknown-session'));
  const safe = source.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return safe || createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function checkpointPath(event) {
  return join(dataDirectory(), 'sessions', sessionKey(event), 'checkpoint.json');
}

function usageHistoryPath() {
  return join(dataDirectory(), 'usage.jsonl');
}

async function atomicWriteText(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function atomicWriteJson(path, value) {
  await atomicWriteText(path, `${JSON.stringify(value)}\n`);
}

async function appendUsageRecord(record) {
  const path = usageHistoryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  const historyStat = await stat(path);
  if (historyStat.size <= 1024 * 1024) return;
  const lines = (await readFile(path, 'utf8')).trim().split('\n').slice(-500);
  await atomicWriteText(path, `${lines.join('\n')}\n`);
}

async function readUsageHistory(limit = 20) {
  try {
    const lines = (await readFile(usageHistoryPath(), 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function createCheckpoint(event, dependencies = {}) {
  const config = dependencies.config || (await loadConfig());
  if (!event.transcript_path) throw new Error('Hook input is missing transcript_path');
  const transcriptStat = await stat(event.transcript_path);
  if (transcriptStat.size > config.maxTranscriptBytes) {
    throw new Error(`Transcript exceeds maxTranscriptBytes (${transcriptStat.size})`);
  }
  const parsed = parseTranscriptJsonl(await readFile(event.transcript_path, 'utf8'));
  const apiKey = dependencies.apiKey ?? (await resolveApiKey(config));
  let selection;
  try {
    selection = await selectToolEvidence(parsed.messages, {
      config,
      apiKey,
      fetchImpl: dependencies.fetchImpl || fetch,
    });
  } catch (error) {
    selection = await selectToolEvidence(parsed.messages, { config, apiKey: '' });
    selection.mode = `fallback-jev-error`;
    selection.warning = error.message;
  }
  const checkpoint = renderCheckpoint(selection, event, config);
  const record = {
    version: 1,
    sessionId: event.session_id || null,
    transcriptPathHash: createHash('sha256').update(resolve(event.transcript_path)).digest('hex'),
    createdAt: new Date().toISOString(),
    checkpoint,
    stats: {
      mode: selection.mode,
      messages: parsed.messages.length,
      malformedLines: parsed.malformedLines,
      calls: selection.calls,
      retained: selection.selections.length,
      requests: selection.requests,
      inputTokens: selection.usage?.inputTokens || 0,
      outputTokens: selection.usage?.outputTokens || 0,
      totalTokens: (selection.usage?.inputTokens || 0) + (selection.usage?.outputTokens || 0),
      warning: selection.warning ? redactSecrets(selection.warning) : undefined,
    },
  };
  await atomicWriteJson(checkpointPath(event), record);
  await appendUsageRecord({
    timestamp: record.createdAt,
    sessionId: record.sessionId,
    trigger: event.trigger || 'unknown',
    mode: record.stats.mode,
    requests: record.stats.requests,
    inputTokens: record.stats.inputTokens,
    outputTokens: record.stats.outputTokens,
    totalTokens: record.stats.totalTokens,
    calls: record.stats.calls,
    retained: record.stats.retained,
    checkpointChars: checkpoint.length,
  });
  return record;
}

export async function restoreCheckpoint(event, dependencies = {}) {
  const config = dependencies.config || (await loadConfig());
  const path = checkpointPath(event);
  const record = JSON.parse(await readFile(path, 'utf8'));
  const age = Date.now() - Date.parse(record.createdAt);
  if (!Number.isFinite(age) || age > config.checkpointMaxAgeMinutes * 60_000) {
    await unlink(path).catch(() => {});
    return null;
  }
  return record;
}

async function doctor() {
  const config = await loadConfig();
  const key = await resolveApiKey(config).catch(() => '');
  return {
    ok: true,
    node: process.version,
    configPath: configPath(),
    dataDirectory: dataDirectory(),
    usageHistoryPath: usageHistoryPath(),
    usageRecords: (await readUsageHistory()).length,
    credentials: key ? 'configured' : 'missing (deterministic fallback active)',
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

async function main() {
  const command = process.argv[2];
  if (command === 'doctor') {
    process.stdout.write(`${JSON.stringify(await doctor(), null, 2)}\n`);
    return;
  }
  if (command === 'history') {
    process.stdout.write(`${JSON.stringify(await readUsageHistory(), null, 2)}\n`);
    return;
  }
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch (error) {
    process.stderr.write(`[codex-jev-compaction] invalid hook input: ${error.message}\n`);
    process.stdout.write('{}\n');
    return;
  }
  try {
    if (command === 'pre-compact') {
      await createCheckpoint(event);
      process.stdout.write('{}\n');
      return;
    }
    if (command === 'session-start') {
      const record = await restoreCheckpoint(event);
      process.stdout.write(
        `${JSON.stringify(
          record
            ? {
                hookSpecificOutput: {
                  hookEventName: 'SessionStart',
                  additionalContext: record.checkpoint,
                },
              }
            : {},
        )}\n`,
      );
      return;
    }
    throw new Error(`Unknown command: ${command || '(missing)'}`);
  } catch (error) {
    process.stderr.write(`[codex-jev-compaction] ${redactSecrets(error.message)}\n`);
    process.stdout.write('{}\n');
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
