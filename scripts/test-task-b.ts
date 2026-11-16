import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalMcpServer } from '../src/mcp/server';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';
import { TrueForgeClient } from '../src/trueforge/client';

async function main() {
  const flaskRoot = 'C:\\dev\\flask';
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8791';
  const pythonExe = path.join(flaskRoot, '.venv', 'Scripts', 'python.exe');

  console.log('=== Task B Verification: Autonomous Agent Mode ===');
  console.log(`[Config] Workspace: ${flaskRoot}`);
  console.log(`[Config] TrueForge: ${trueforgeUrl}`);
  console.log(`[Config] Python Venv: ${pythonExe}`);

  if (!fs.existsSync(pythonExe)) {
    throw new Error(`Python executable not found at ${pythonExe}`);
  }

  WorkspaceRetrieval.setWorkspaceRoot(flaskRoot);

  // Backup files that might be modified
  const backupFiles = [
    path.join(flaskRoot, 'src', 'flask', 'cli.py'),
    path.join(flaskRoot, 'tests', 'test_cli.py'),
    path.join(flaskRoot, 'docs', 'cli.rst'),
  ];
  const originalContents = new Map<string, string>();
  for (const f of backupFiles) {
    if (fs.existsSync(f)) {
      originalContents.set(f, await fs.promises.readFile(f, 'utf-8'));
    }
  }

  // 1. Start Local MCP Server with Review Engine
  console.log('\n⏳ [1/5] Starting Local MCP Server on port 8795...');
  const reviewEngine = new DiffReviewEngine();
  const mcpServer = new LocalMcpServer(reviewEngine);
  const mcpInfo = await mcpServer.start(8795);
  console.log(`✅ [1/5] MCP Server running on port ${mcpInfo.port}`);

  const tfClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models: ['google-gemini/gemini-3-1-flash-lite'],
  });

  // 2. Register MCP Server
  console.log('\n⏳ [2/5] Registering MCP Server with TrueForge...');
  await tfClient.registerMcpServer({
    name: 'vscode-ide',
    url: mcpInfo.url,
    description: 'VS Code IDE capabilities for Flask repo',
    bearerToken: mcpInfo.token,
  });
  console.log('✅ [2/5] Registered MCP server "vscode-ide"');

  // 3. Create Session with inline spec
  console.log('\n⏳ [3/5] Creating TrueForge session...');
  const sessionId = await tfClient.createSession({
    mcpServerName: 'vscode-ide',
    requireApprovalForTools: ['propose_edit', 'run_command'],
  });
  console.log(`✅ [3/5] Created session: ${sessionId}`);

  // 4. Send Task B Instruction (NO file names mentioned!)
  console.log('\n⏳ [4/5] Sending Task B instruction (no file names mentioned)...');
  const taskBPrompt =
    'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

  console.log(`Prompt: "${taskBPrompt}"\n`);

  const modifiedFiles = new Set<string>();
  const executedCommands: string[] = [];
  let currentTurnId = '';

  const runStreamTurn = async (prompt: string): Promise<void> => {
    await tfClient.streamTurn(sessionId, prompt, {
      onTurnCreated: (turnId) => {
        currentTurnId = turnId;
        console.log(`\n  [Turn Created] Turn ID: ${turnId}`);
      },
      onDelta: (chunk) => {
        process.stdout.write(chunk);
      },
      onToolCall: (call) => {
        console.log(`\n  🔧 [Tool Call] ${call.name} (ID: ${call.id})`);
        if (call.arguments) {
          const preview = JSON.stringify(call.arguments);
          console.log(`     Args: ${preview.length > 200 ? preview.slice(0, 200) + '...' : preview}`);
        }
      },
      onToolResponse: (resp) => {
        const preview = resp.content.length > 250 ? resp.content.slice(0, 250) + '...' : resp.content;
        console.log(`\n  ⚡ [Tool Response] ID: ${resp.toolCallId} -> ${preview.replace(/\n/g, ' ')}`);
      },
      onApprovalRequired: async (calls) => {
        console.log(`\n  🎯 [Approval Required] Gated tool call(s): ${calls.length}`);
        for (const call of calls) {
          const isProposeEdit = call.name === 'propose_edit' || call.arguments?.tool_name === 'propose_edit';
          const isRunCommand = call.name === 'run_command' || call.arguments?.tool_name === 'run_command';

          if (isProposeEdit) {
            const realArgs = call.arguments?.input || call.arguments;
            const file = realArgs?.file || realArgs?.path;
            const explanation = realArgs?.explanation || realArgs?.description || 'Proposed code changes';
            const newContent = realArgs?.new_content || realArgs?.newContent || realArgs?.content;
            const hunks = realArgs?.edits || realArgs?.hunks;

            console.log(`\n    [Approval: propose_edit] Staging edit for ${file}...`);
            const staged = await reviewEngine.stageEdit(call.id, file, explanation, { newContent, hunks });
            modifiedFiles.add(file.replace(/\\/g, '/'));
            console.log(`    Staged with ${staged.hunks.length} hunk(s):`);
            for (const h of staged.hunks) {
              console.log(`      * Hunk ${h.id} (Lines ${h.oldStart}-${h.oldStart + h.oldLines})`);
            }

            console.log(`    Auto-accepting all hunks and sending tool approval 'allow'...`);
            reviewEngine.setAllHunksDecision(call.id, 'accepted');
            await tfClient.sendToolApproval(sessionId, currentTurnId, call.id, 'allow');
          } else if (isRunCommand) {
            const realArgs = call.arguments?.input || call.arguments;
            const cmd = realArgs?.command || 'unknown command';
            executedCommands.push(cmd);
            console.log(`\n    [Approval: run_command] Command: "${cmd}"`);
            console.log(`    Auto-approving command execution...`);
            await tfClient.sendToolApproval(sessionId, currentTurnId, call.id, 'allow');
          } else {
            console.log(`\n    [Approval: ${call.name}] Auto-approving...`);
            await tfClient.sendToolApproval(sessionId, currentTurnId, call.id, 'allow');
          }
        }
      },
      onDone: (status, reason, metrics) => {
        console.log(`\n  [Turn Done] Status: ${status} | Tokens: ${metrics?.totalTokens ?? 'N/A'}`);
      },
      onError: (err) => {
        console.error(`\n  [Turn Error] ${err.message}`);
      },
    });
  };

  try {
    // Execute turn 1
    await runStreamTurn(taskBPrompt);

    // If the agent didn't finish running tests or touching all files yet, send a continuation turn
    const hasCliEdit = Array.from(modifiedFiles).some((f) => f.includes('cli.py'));
    const hasTestEdit = Array.from(modifiedFiles).some((f) => f.includes('test_cli.py') || f.includes('tests/'));
    const hasDocEdit = Array.from(modifiedFiles).some((f) => f.includes('docs/'));
    const ranPytest = executedCommands.some((c) => c.includes('pytest'));

    console.log('\n--- Mid-Task Progress Check ---');
    console.log(`Modified files (${modifiedFiles.size}):`, Array.from(modifiedFiles));
    console.log(`Executed commands (${executedCommands.length}):`, executedCommands);
    console.log(`Touches CLI: ${hasCliEdit}, Touches Tests: ${hasTestEdit}, Touches Docs: ${hasDocEdit}, Ran pytest: ${ranPytest}`);

    if (!hasCliEdit || !hasTestEdit || !hasDocEdit || !ranPytest) {
      console.log('\n⏳ Sending follow-up turn to complete remaining phases (docs, test, run pytest)...');
      const followUp =
        'Please complete the remaining requirements: ensure `src/flask/cli.py` registers the command, `tests/test_cli.py` has a test for masking SECRET, PASSWORD, TOKEN, KEY, `docs/cli.rst` documents it, and run `pytest tests/test_cli.py -q` via run_command to verify it passes.';
      await runStreamTurn(followUp);
    }

    console.log('\n⏳ [5/5] Verifying Task B results in Flask repository...');

    // 5.1 Verify at least 3 files modified
    console.log(`\n5.1 Modified files count: ${modifiedFiles.size}`);
    for (const f of modifiedFiles) {
      console.log(`    - ${f}`);
    }
    if (modifiedFiles.size < 3) {
      throw new Error(`Task B requires touching 3+ files, but only touched ${modifiedFiles.size} file(s).`);
    }
    console.log('  ✅ 5.1 Verified: Diff touched 3+ files!');

    // 5.2 Verify flask --help contains 'config'
    console.log('\n5.2 Checking flask --help for "config" command...');
    const helpRes = await WorkspaceRetrieval.runCommand('flask --help');
    console.log(helpRes.stdout);
    if (!helpRes.stdout.toLowerCase().includes('config')) {
      throw new Error(`"config" command does not appear in flask --help output!`);
    }
    console.log('  ✅ 5.2 Verified: "config" command appears in flask --help output!');

    // 5.3 Run pytest tests/test_cli.py -q
    console.log('\n5.3 Running pytest tests/test_cli.py -q...');
    const pytestRes = await WorkspaceRetrieval.runCommand('pytest tests/test_cli.py -q');
    console.log(`Pytest Exit Code: ${pytestRes.exitCode}`);
    console.log(pytestRes.stdout);
    if (pytestRes.stderr) console.error(pytestRes.stderr);
    if (pytestRes.exitCode !== 0) {
      throw new Error(`pytest tests/test_cli.py failed with exit code ${pytestRes.exitCode}`);
    }
    console.log('  ✅ 5.3 Verified: pytest tests/test_cli.py passes with 0 failures!');

    // 5.4 Test config command masking with Python
    console.log('\n5.4 Testing flask config JSON output and masking of SECRET, PASSWORD, TOKEN, KEY...');
    const maskTestScript = `
import json
import click
from click.testing import CliRunner
from flask import Flask
from flask.cli import FlaskGroup

app = Flask("test_config")
app.config["MY_SECRET_KEY"] = "super-secret-value"
app.config["DB_PASSWORD"] = "mypassword123"
app.config["API_TOKEN"] = "token-xyz"
app.config["ACCESS_KEY"] = "access-key-999"
app.config["PUBLIC_SETTING"] = "hello-world"
app.config["DEBUG"] = False

cli = FlaskGroup(create_app=lambda: app)
runner = CliRunner()
result = runner.invoke(cli, ["config"])
print("EXIT_CODE:", result.exit_code)
print("OUTPUT:")
print(result.output)

if result.exit_code != 0:
    raise SystemExit(1)

data = json.loads(result.output)
assert data["MY_SECRET_KEY"] == "***", f"Expected *** but got {data['MY_SECRET_KEY']}"
assert data["DB_PASSWORD"] == "***", f"Expected *** but got {data['DB_PASSWORD']}"
assert data["API_TOKEN"] == "***", f"Expected *** but got {data['API_TOKEN']}"
assert data["ACCESS_KEY"] == "***", f"Expected *** but got {data['ACCESS_KEY']}"
assert data["PUBLIC_SETTING"] == "hello-world", f"Public setting changed: {data['PUBLIC_SETTING']}"
print("ALL_ASSERTIONS_PASSED")
`;

    const maskRes = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `& "${pythonExe}" -c '${maskTestScript.replace(/'/g, "''")}'`,
    ], { cwd: flaskRoot, encoding: 'utf-8' });

    console.log(maskRes.stdout);
    if (maskRes.stderr) console.error(maskRes.stderr);
    if (maskRes.status !== 0 || !maskRes.stdout.includes('ALL_ASSERTIONS_PASSED')) {
      throw new Error(`flask config masking verification failed! Stderr: ${maskRes.stderr}`);
    }
    console.log('  ✅ 5.4 Verified: flask config outputs valid JSON and masks SECRET, PASSWORD, TOKEN, KEY as "***"!');

    // 5.5 Test Undo Last Applied Change
    console.log('\n5.5 Testing Undo Last Applied Change to restore workspace...');
    while (reviewEngine.getUndoHistorySize() > 0) {
      const undoRes = await reviewEngine.undoLastChange(flaskRoot);
      console.log(`  Undo: ${undoRes.message}`);
    }

    // Double check git status
    const gitStatusRes = spawnSync('git', ['status', '--porcelain'], { cwd: flaskRoot, encoding: 'utf-8' });
    console.log(`Flask git status after undo:\n"${gitStatusRes.stdout.trim()}"`);
    if (gitStatusRes.stdout.trim().length > 0) {
      console.log('Restoring any remaining uncommitted changes via backup...');
      for (const [filePath, content] of originalContents) {
        await fs.promises.writeFile(filePath, content, 'utf-8');
      }
    }
    console.log('  ✅ 5.5 Verified: Workspace cleanly restored!');

    console.log('\n🎉🎉🎉 TASK B VERIFICATION PASSED COMPLETELY! 🎉🎉🎉');
  } finally {
    // Restore backups in case of any unhandled failure
    for (const [filePath, content] of originalContents) {
      if (fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, content, 'utf-8');
      }
    }
    await mcpServer.stop();
    console.log('MCP Server stopped and Flask workspace verified clean.');
  }
}

main().catch((err) => {
  console.error('Task B Verification Failed:', err);
  process.exit(1);
});
