// Codex CLI adapter for the Feishu bot.
//
// This module intentionally does not depend on a vendor SDK. It invokes the local
// Codex CLI in non-interactive JSON mode and normalizes JSONL events for index.js.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const LOCAL_CODEX_BIN = fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url));
// Windows 下 .bin/codex 是 sh 脚本，spawn 无法直接执行；改用 node 启动包内 JS 入口
const LOCAL_CODEX_JS = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));

function cliPath() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform === 'win32' && existsSync(LOCAL_CODEX_JS)) return LOCAL_CODEX_JS;
  if (existsSync(LOCAL_CODEX_BIN)) return LOCAL_CODEX_BIN;
  return 'codex';
}

function buildArgs({ resumeThreadId, model, sandboxMode, ephemeral = false, ignoreRules = false, outputSchema = '' }) {
  // exec-level options must precede the optional `resume` subcommand.
  const args = ['exec', '--json', '--skip-git-repo-check'];

  // The bot runs unattended. Keep model-generated commands confined to the
  // per-user workspace unless CODEX_SANDBOX_MODE explicitly overrides it.
  args.push('--sandbox', sandboxMode || 'workspace-write');

  if (ephemeral) args.push('--ephemeral');
  if (ignoreRules) args.push('--ignore-rules');
  if (outputSchema) args.push('--output-schema', outputSchema);
  if (model) args.push('--model', model);
  if (resumeThreadId) args.push('resume', resumeThreadId);
  args.push('-'); // Read the prompt from stdin to avoid shell argument limits.

  return args;
}

export async function* runCodexQuery({
  prompt,
  cwd,
  resumeThreadId,
  abortController = new AbortController(),
  model = process.env.CODEX_MODEL,
  sandboxMode = process.env.CODEX_SANDBOX_MODE || 'workspace-write',
  ephemeral = false,
  ignoreRules = false,
  outputSchema = '',
  log = () => {},
}) {
  const command = cliPath();
  const args = buildArgs({ resumeThreadId, model, sandboxMode, ephemeral, ignoreRules, outputSchema });
  // 入口是 .js 时（Windows 路径或自定义 CODEX_BIN），用当前 node 进程启动
  const runViaNode = command.endsWith('.js');
  const env = { ...process.env };
  // dotenv values can be relative to the project root; CODEX_HOME should not
  // silently change when Codex changes its working directory.
  if (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME)) {
    env.CODEX_HOME = resolve(process.cwd(), env.CODEX_HOME);
  }

  const child = spawn(runViaNode ? process.execPath : command, runViaNode ? [command, ...args] : args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderrTail = [];
  let threadId = resumeThreadId || '';
  let finalText = '';
  let sawCompletedTurn = false;
  let exitCode = null;
  let waitForExit;

  const stdoutRead = createInterface({ input: child.stdout });
  const stderrRead = createInterface({ input: child.stderr });

  stderrRead.on('line', line => {
    const text = line.trim();
    if (!text) return;
    if (stderrTail.length >= 30) stderrTail.shift();
    stderrTail.push(text);
    if (/warn|error|failed/i.test(text)) log('dim', 'codex-stderr', text.slice(0, 500));
  });

  waitForExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      exitCode = code;
      resolve({ code, signal });
    });
  });

  const abort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
  };
  abortController.signal.addEventListener('abort', abort, { once: true });

  try {
    child.stdin.on('error', err => {
      // Codex can exit early because of invalid auth/config. The close error
      // below carries the useful stderr tail. Never throw from this listener:
      // an uncaught error in an EventEmitter would kill the whole bot.
      if (err.code !== 'EPIPE') log('error', 'codex-stdin', err.message);
    });
    child.stdin.end(prompt);

    for await (const line of stdoutRead) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        log('dim', 'codex-json', `unparsed output: ${trimmed.slice(0, 300)}`);
        continue;
      }

      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: threadId,
          model: model || 'configured-default',
          tools: [],
        };
        continue;
      }

      if (event.type === 'turn.started') {
        yield { type: 'system', subtype: 'turn_started', session_id: threadId };
        continue;
      }

      if (event.type === 'item.completed') {
        const item = event.item || {};
        if (item.type === 'agent_message' && item.text) {
          finalText = item.text;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: item.text }] },
          };
        } else if (item.type === 'error' && item.message) {
          yield { type: 'system', subtype: 'error', message: item.message };
        } else if (item.type === 'command_execution') {
          const detail = item.command || item.command_input || '';
          log('dim', 'codex-tool', `${item.exit_code ?? '?'} ${String(detail).slice(0, 250)}`);
          yield {
            type: 'user',
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: item.id,
                content: `command:${String(detail)}`,
                is_error: Number(item.exit_code) > 0,
              }],
            },
          };
        } else if (item.type === 'file_change') {
          const detail = item.changes ? JSON.stringify(item.changes) : JSON.stringify(item);
          log('dim', 'codex-file', detail.slice(0, 300));
        }
        continue;
      }

      if (event.type === 'turn.completed') {
        sawCompletedTurn = true;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: threadId,
          result: finalText,
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: event.duration_ms,
          usage: event.usage,
        };
        continue;
      }

      if (event.type === 'turn.failed') {
        const message = event.error?.message || 'Codex turn failed';
        throw new Error(message);
      }

      if (event.type === 'error' && event.message) {
        log('warn', 'codex', event.message.slice(0, 500));
      }
    }

    const closeResult = await waitForExit;

    if (abortController.signal.aborted) {
      throw new Error('Codex query aborted');
    }

    if (closeResult.code !== 0 && !finalText) {
      const detail = stderrTail.join('\n').slice(-1200);
      throw new Error(detail || `Codex CLI exited with code ${closeResult.code}`);
    }

    // Defensive fallback for a CLI that exits successfully without emitting a
    // turn.completed event.
    if (!sawCompletedTurn && finalText) {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: threadId,
        result: finalText,
        total_cost_usd: 0,
        num_turns: 1,
      };
    }
  } finally {
    abortController.signal.removeEventListener('abort', abort);
    stdoutRead.close();
    stderrRead.close();

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([waitForExit, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}
