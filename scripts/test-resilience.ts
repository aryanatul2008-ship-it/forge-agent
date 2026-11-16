import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TrueForgeClient } from '../src/trueforge/client';
import { LocalMcpServer } from '../src/mcp/server';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';
import {
  formatHumanReadableError,
  calculateBackoffDelay,
  DEFAULT_RESILIENCE_CONFIG,
} from '../src/trueforge/resilience';

async function main() {
  console.log('=== Running TrueForge Resilience & Error Recovery Tests ===\n');

  // Test Suite 1: formatHumanReadableError and Backoff Calculation
  console.log('--- Test Suite 1: Error Formatting & Exponential Backoff ---');

  // 1.1 Unreachable endpoint formatting
  const networkErr = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:59999\n    at Object.fetch (node:internal/deps/undici/undici:13110:11)');
  const humanNetMsg = formatHumanReadableError(networkErr, { baseUrl: 'http://127.0.0.1:59999' });
  console.log('1.1 Network error formatted:', humanNetMsg);
  if (!humanNetMsg.includes('Cannot connect to TrueForge at http://127.0.0.1:59999') || humanNetMsg.includes('at Object.')) {
    throw new Error('Network error formatting failed or leaked stack trace');
  }
  console.log('  ✅ 1.1 Network error formatted cleanly without stack trace');

  // 1.2 Invalid API key formatting
  const authErr = new Error('401 Unauthorized: {"error": {"message": "API_KEY_INVALID: Please configure a valid key."}}\n    at TurnStream.next (node_modules/trueforge/stream.js:45)');
  const humanAuthMsg = formatHumanReadableError(authErr, { model: 'google-gemini/gemini-3-1-flash-lite' });
  console.log('1.2 Auth error formatted:', humanAuthMsg);
  if (!humanAuthMsg.includes('Authentication failed: The API key for model') || humanAuthMsg.includes('node_modules')) {
    throw new Error('Auth error formatting failed or leaked stack trace');
  }
  console.log('  ✅ 1.2 Auth error formatted cleanly without stack trace');

  // 1.3 Rate limit formatting
  const rateLimitErr = new Error('429 RESOURCE_EXHAUSTED: Rate limit exceeded');
  const humanRateMsg = formatHumanReadableError(rateLimitErr, { model: 'google-gemini/gemini-3-1-flash-lite' });
  console.log('1.3 Rate limit formatted:', humanRateMsg);
  if (!humanRateMsg.includes('Rate limit or quota exceeded')) {
    throw new Error('Rate limit formatting failed');
  }
  console.log('  ✅ 1.3 Rate limit formatted cleanly');

  // 1.4 Unknown model formatting
  const modelErr = new Error('422 Unprocessable Entity: Unknown model "bad-model" — not configured on provider');
  const humanModelMsg = formatHumanReadableError(modelErr, { model: 'bad-model' });
  console.log('1.4 Unknown model formatted:', humanModelMsg);
  if (!humanModelMsg.includes('Model "bad-model" is not available or not configured')) {
    throw new Error('Unknown model formatting failed');
  }
  console.log('  ✅ 1.4 Unknown model formatted cleanly');

  // 1.5 Exponential Backoff Progression
  const b0 = calculateBackoffDelay(1, { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 1000, maxBackoffMs: 8000, backoffMultiplier: 2 });
  const b1 = calculateBackoffDelay(2, { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 1000, maxBackoffMs: 8000, backoffMultiplier: 2 });
  console.log(`1.5 Backoff progression: retry 1 = ${b0}ms, retry 2 = ${b1}ms`);
  if (b0 < 1000 || b0 > 1200 || b1 < 2000 || b1 > 2400) {
    throw new Error('Exponential backoff delay progression calculation out of expected range');
  }
  console.log('  ✅ 1.5 Exponential backoff progression verified');

  // Test Suite 2: Simulation 1 - Unreachable Endpoint
  console.log('\n--- Test Suite 2: Unreachable Endpoint (Backoff Retries) ---');
  const unreachableClient = new TrueForgeClient({
    baseUrl: 'http://127.0.0.1:59999', // Port with no server listening
    models: ['google-gemini/gemini-3-1-flash-lite'],
  });

  const retryNotices: string[] = [];
  const statusUpdates: string[] = [];

  const unreachableResult = await unreachableClient.streamTurnWithResilience(
    'Hello',
    {
      onNotice: (msg) => retryNotices.push(msg),
      onStatusUpdate: (status) => statusUpdates.push(status),
    },
    {
      maxRetriesPerModel: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 300,
    }
  );

  console.log(`2.1 Unreachable result status: "${unreachableResult.status}", attempts: ${unreachableResult.attempts}`);
  console.log(`2.1 Retry notices received (${retryNotices.length}):`, retryNotices);
  console.log(`2.1 Final reason: "${unreachableResult.reason}"`);

  if (unreachableResult.status !== 'error') {
    throw new Error(`Expected status 'error', got '${unreachableResult.status}'`);
  }
  if (unreachableResult.attempts !== 3) {
    throw new Error(`Expected exactly 3 attempts (1 initial + 2 retries), got ${unreachableResult.attempts}`);
  }
  if (retryNotices.length !== 2) {
    throw new Error(`Expected 2 retry notices, got ${retryNotices.length}`);
  }
  if (!unreachableResult.reason?.includes('Cannot connect to TrueForge at http://127.0.0.1:59999')) {
    throw new Error('Expected clean connection error message');
  }
  if (unreachableResult.reason.includes('    at ') || unreachableResult.reason.includes('node:')) {
    throw new Error('Stack trace leaked in unreachable error reason');
  }
  console.log('  ✅ 2.1 Unreachable endpoint retried 2 times with backoff and returned human error without stack trace');

  // Test Suite 3: Simulation 2 - Model Fallback on TrueForge
  console.log('\n--- Test Suite 3: Automatic Model Fallback ---');
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

  // Check if live TrueForge is running
  let liveTfAvailable = false;
  try {
    const res = await fetch(`${trueforgeUrl}/api/v1/models`);
    if (res.ok) liveTfAvailable = true;
  } catch {}

  if (!liveTfAvailable) {
    console.log(`⚠️ TrueForge server not responding at ${trueforgeUrl}. Skipping live fallback/task-a tests.`);
    return;
  }

  // Setup temporary MCP server for tool capabilities
  const reviewEngine = new DiffReviewEngine();
  const mcpServer = new LocalMcpServer(reviewEngine);
  const mcpInfo = await mcpServer.start(0);

  const fallbackClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models: [
      'google-gemini/nonexistent-invalid-model', // Primary: will fail
      'google-gemini/gemini-3-1-flash-lite',     // Fallback: valid model
    ],
  });

  await fallbackClient.registerMcpServer({
    name: 'vscode-ide',
    url: mcpInfo.url,
    description: 'Resilience Test MCP Server',
    bearerToken: mcpInfo.token,
  });

  const fallbackNotices: string[] = [];
  let tokenCount = 0;

  const fallbackResult = await fallbackClient.streamTurnWithResilience(
    'Please reply with exactly the word "FALLBACK_SUCCESS".',
    {
      onNotice: (msg, level) => {
        console.log(`[Notice (${level || 'warning'})] ${msg}`);
        fallbackNotices.push(msg);
      },
      onDelta: (t) => {
        tokenCount += t.length;
      },
    },
    {
      maxRetriesPerModel: 1, // 1 retry per model for fast test
      initialBackoffMs: 200,
    }
  );

  console.log(`3.1 Fallback result status: "${fallbackResult.status}", modelUsed: "${fallbackResult.modelUsed}", attempts: ${fallbackResult.attempts}`);
  if (fallbackResult.status !== 'done') {
    throw new Error(`Expected fallback turn to succeed ('done'), got '${fallbackResult.status}'`);
  }
  if (fallbackResult.modelUsed !== 'google-gemini/gemini-3-1-flash-lite') {
    throw new Error(`Expected modelUsed to be fallback model, got '${fallbackResult.modelUsed}'`);
  }
  if (!fallbackNotices.some((n) => n.includes('Switching to fallback model'))) {
    throw new Error('Notice for switching to fallback model was not emitted');
  }
  console.log('  ✅ 3.1 Primary model failure caught, notice surfaced, and fallback model completed turn successfully');

  // Test Suite 4: Simulation 3 - All Models Fail (Terminal Failure)
  console.log('\n--- Test Suite 4: All Models Fail (Terminal Recovery) ---');
  const allFailClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models: [
      'google-gemini/bad-model-alpha',
      'google-gemini/bad-model-beta',
    ],
  });

  const terminalNotices: string[] = [];
  const allFailResult = await allFailClient.streamTurnWithResilience(
    'Hello',
    {
      onNotice: (msg) => terminalNotices.push(msg),
    },
    {
      maxRetriesPerModel: 1,
      initialBackoffMs: 100,
    }
  );

  console.log(`4.1 All fail result status: "${allFailResult.status}", attempts: ${allFailResult.attempts}`);
  console.log(`4.1 Human-readable error message:\n    "${allFailResult.reason}"`);
  if (allFailResult.status !== 'error') {
    throw new Error(`Expected terminal error status, got '${allFailResult.status}'`);
  }
  if (!allFailResult.reason?.includes('not available or not configured in TrueForge')) {
    throw new Error('Expected clean model error notice in reason');
  }
  if (allFailResult.reason.includes('    at ') || allFailResult.reason.includes('node_modules')) {
    throw new Error('Stack trace leaked in terminal failure reason');
  }
  console.log('  ✅ 4.1 All models failed gracefully with human-readable error (no stack trace)');

  // Test Suite 5: Simulation 4 - Task A with a Bad Key / Bad Model (Clean Workspace Verification)
  console.log('\n--- Test Suite 5: Task A with Bad Key / Bad Model (Workspace Cleanliness) ---');
  const flaskRoot = 'C:\\dev\\flask';

  if (!fs.existsSync(flaskRoot)) {
    console.log(`Flask directory ${flaskRoot} not found. Skipping Task A workspace verification.`);
    await mcpServer.stop();
    return;
  }

  WorkspaceRetrieval.setWorkspaceRoot(flaskRoot);

  // Check initial git status in Flask
  const initialGit = spawnSync('powershell.exe', ['-NoProfile', '-Command', `cd "${flaskRoot}"; git status --porcelain`], {
    encoding: 'utf-8',
  });
  if (initialGit.stdout.trim().length > 0) {
    throw new Error(`Flask workspace was not clean before Task A test:\n${initialGit.stdout}`);
  }
  console.log('5.1 Verified initial Flask git status: 100% clean');

  const badKeyClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models: ['google-gemini/invalid-key-model'],
  });

  const taskAPrompt = [
    'You are performing an inline edit in VS Code on file "src/flask/helpers.py".',
    'User Instruction: Treat the values "off" and "n" as false as well, case-insensitively.',
    'CRITICAL: Call propose_edit tool with modified code.',
  ].join('\n');

  console.log('5.2 Attempting Task A with bad credentials / invalid model...');
  const taskAResult = await badKeyClient.streamTurnWithResilience(
    taskAPrompt,
    {
      onNotice: (msg) => console.log(`[Task A Notice] ${msg}`),
    },
    {
      maxRetriesPerModel: 1,
      initialBackoffMs: 100,
    }
  );

  console.log(`5.2 Task A result status: "${taskAResult.status}", reason: "${taskAResult.reason}"`);
  if (taskAResult.status !== 'error') {
    throw new Error(`Expected Task A with bad key to fail with status 'error', got '${taskAResult.status}'`);
  }

  // Clear staged edits to ensure complete clean state
  reviewEngine.clearAllStagedEdits();

  // Verify Flask git status after failure
  const postGit = spawnSync('powershell.exe', ['-NoProfile', '-Command', `cd "${flaskRoot}"; git status --porcelain`], {
    encoding: 'utf-8',
  });
  const postStatus = postGit.stdout.trim();
  console.log('5.3 Flask git status after failure: "' + postStatus + '"');
  if (postStatus.length > 0) {
    throw new Error(`Flask workspace was modified during failed turn! Git status:\n${postStatus}`);
  }
  console.log('  ✅ 5.3 Task A with bad key failed safely: git status remains 100% clean with ZERO modified files');

  await mcpServer.stop();
  console.log('\n🎉 ALL RESILIENCE & ERROR RECOVERY TESTS PASSED SUCCESSFULLY! 🎉');
}

main().catch((err) => {
  console.error('\n❌ Resilience test failed with error:', err);
  process.exit(1);
});
