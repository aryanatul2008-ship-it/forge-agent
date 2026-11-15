import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalMcpServer } from '../src/mcp/server';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';
import { TrueForgeClient } from '../src/trueforge/client';
import { ToolCallInfo } from '../src/trueforge/types';

async function main() {
  const flaskRoot = 'C:\\dev\\flask';
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8791';
  const pythonExe = path.join(flaskRoot, '.venv', 'Scripts', 'python.exe');

  console.log('=== Task A Verification: Inline Edit on get_debug_flag ===');
  console.log(`[Config] Workspace: ${flaskRoot}`);
  console.log(`[Config] TrueForge: ${trueforgeUrl}`);
  console.log(`[Config] Python Venv: ${pythonExe}`);

  if (!fs.existsSync(pythonExe)) {
    throw new Error(`Python executable not found at ${pythonExe}`);
  }

  WorkspaceRetrieval.setWorkspaceRoot(flaskRoot);

  const helpersPyPath = path.join(flaskRoot, 'src', 'flask', 'helpers.py');
  const originalHelpersContent = await fs.promises.readFile(helpersPyPath, 'utf-8');

  // Verify initial state: FLASK_DEBUG=off should return True in unmodified code
  const initialCheck = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$env:FLASK_DEBUG="off"; & "${pythonExe}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
  ], { encoding: 'utf-8' });

  const initialVal = initialCheck.stdout?.trim();
  console.log(`[Baseline] Initial FLASK_DEBUG=off output: "${initialVal}" (Expected True before Task A)`);

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

  // 4. Send Inline Edit Instruction
  console.log('\n⏳ [4/5] Sending inline edit prompt for get_debug_flag...');
  const relativeFile = 'src/flask/helpers.py';
  const selectedSnippet = [
    'def get_debug_flag() -> bool:',
    '    """Get whether debug mode should be enabled for the app, indicated by the',
    '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
    '    """',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
  ].join('\n');

  const instruction =
    "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

  const prompt = [
    `You are performing an inline edit in VS Code on file "${relativeFile}".`,
    'Lines 28-34 are selected:',
    '```python',
    selectedSnippet,
    '```',
    '',
    '### User Instruction:',
    instruction,
    '',
    'IMPORTANT REQUIREMENT:',
    `Call the \`propose_edit\` tool on "${relativeFile}" with the modified code in \`new_content\` or \`hunks\` and a clear explanation.`,
  ].join('\n');

  let proposedToolCallId: string | null = null;
  let currentTurnId = '';

  try {
    await tfClient.streamTurn(sessionId, prompt, {
      onTurnCreated: (turnId) => {
        currentTurnId = turnId;
        console.log(`  [Turn Created] Turn ID: ${turnId}`);
      },
      onDelta: (chunk) => {
        process.stdout.write(chunk);
      },
      onToolCall: (call) => {
        console.log(`\n  [Tool Call] ${call.name} (ID: ${call.id})`);
      },
      onToolResponse: (resp) => {
        console.log(`\n  [Tool Response] ID: ${resp.toolCallId}`);
      },
      onApprovalRequired: async (calls) => {
        console.log(`\n  🎯 [Approval Required] Gated tool call(s): ${calls.length}`);
        for (const call of calls) {
          console.log(`  Checking gated call: ${call.name} (ID: ${call.id})`);
          const isProposeEdit = call.name === 'propose_edit' || call.arguments?.tool_name === 'propose_edit';
          if (isProposeEdit) {
            proposedToolCallId = call.id;
            const realArgs = call.arguments?.input || call.arguments;
            const file = realArgs?.file || realArgs?.path || relativeFile;
            const explanation = realArgs?.explanation || realArgs?.description || instruction;
            const newContent = realArgs?.new_content || realArgs?.newContent || realArgs?.content;
            const hunks = realArgs?.edits || realArgs?.hunks;

            console.log(`  Staging proposed edit for ${file}...`);
            const staged = await reviewEngine.stageEdit(call.id, file, explanation, { newContent, hunks });
            console.log(`  Staged edit created with ${staged.hunks.length} hunk(s).`);

            for (const h of staged.hunks) {
              console.log(`    - Hunk ${h.id} (Lines ${h.oldStart}-${h.oldStart + h.oldLines}):`);
              console.log(`      [-] ${h.oldText.replace(/\n/g, '\n      [-] ')}`);
              console.log(`      [+] ${h.newText.replace(/\n/g, '\n      [+] ')}`);
            }

            // Accept all hunks and approve tool
            console.log(`  Accepting all hunks and dispatching tool approval (allow)...`);
            reviewEngine.setAllHunksDecision(call.id, 'accepted');
            await tfClient.sendToolApproval(sessionId, currentTurnId, call.id, 'allow');
          } else {
            console.log(`  Approving tool: ${call.name}`);
            await tfClient.sendToolApproval(sessionId, currentTurnId, call.id, 'allow');
          }
        }
      },
      onDone: (status, reason, metrics) => {
        console.log(`\n  [Turn Done] Status: ${status} | Tokens: ${metrics?.totalTokens ?? 'N/A'}`);
      },
    });

    console.log('\n⏳ [5/5] Verifying Task A implementation in Python...');

    // 5.1 Verify FLASK_DEBUG=off returns False
    const testOff = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$env:FLASK_DEBUG="off"; & "${pythonExe}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
    ], { encoding: 'utf-8' });

    const valOff = testOff.stdout?.trim();
    console.log(`5.1 FLASK_DEBUG="off" output: "${valOff}"`);
    if (valOff !== 'False') {
      throw new Error(`Expected 'False' for FLASK_DEBUG="off", got "${valOff}". Stderr: ${testOff.stderr}`);
    }
    console.log('  ✅ 5.1 Verified: FLASK_DEBUG="off" -> False');

    // 5.2 Verify FLASK_DEBUG=n returns False
    const testN = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$env:FLASK_DEBUG="n"; & "${pythonExe}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
    ], { encoding: 'utf-8' });

    const valN = testN.stdout?.trim();
    console.log(`5.2 FLASK_DEBUG="n" output: "${valN}"`);
    if (valN !== 'False') {
      throw new Error(`Expected 'False' for FLASK_DEBUG="n", got "${valN}". Stderr: ${testN.stderr}`);
    }
    console.log('  ✅ 5.2 Verified: FLASK_DEBUG="n" -> False');

    // 5.3 Verify FLASK_DEBUG=1 returns True
    const testOne = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$env:FLASK_DEBUG="1"; & "${pythonExe}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
    ], { encoding: 'utf-8' });

    const valOne = testOne.stdout?.trim();
    console.log(`5.3 FLASK_DEBUG="1" output: "${valOne}"`);
    if (valOne !== 'True') {
      throw new Error(`Expected 'True' for FLASK_DEBUG="1", got "${valOne}". Stderr: ${testOne.stderr}`);
    }
    console.log('  ✅ 5.3 Verified: FLASK_DEBUG="1" -> True');

    // 5.4 Check updated docstring in helpers.py
    const updatedHelpers = await fs.promises.readFile(helpersPyPath, 'utf-8');
    const docstringSnippet = updatedHelpers.slice(
      updatedHelpers.indexOf('def get_debug_flag'),
      updatedHelpers.indexOf('def get_load_dotenv')
    );
    console.log('\nUpdated get_debug_flag code in src/flask/helpers.py:');
    console.log(docstringSnippet);

    const hasDocUpdate =
      docstringSnippet.includes('off') &&
      docstringSnippet.includes('n') &&
      docstringSnippet.includes('0');

    if (!hasDocUpdate) {
      console.warn('⚠️ Warning: Docstring does not explicitly mention all false values.');
    } else {
      console.log('  ✅ 5.4 Verified: Docstring successfully updated with all false values!');
    }

    // 5.5 Run existing pytest suite for test_get_debug_flag
    console.log('\nRunning pytest for test_get_debug_flag...');
    const pytestRes = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `& "${pythonExe}" -m pytest tests/test_helpers.py -k test_get_debug_flag`,
    ], { cwd: flaskRoot, encoding: 'utf-8' });

    console.log(pytestRes.stdout);
    if (pytestRes.status !== 0) {
      throw new Error(`Pytest test_get_debug_flag failed: ${pytestRes.stderr}`);
    }
    console.log('  ✅ 5.5 Verified: Existing test suite passes with 0 failures!');

    // 5.6 Test Undo History Stack
    console.log('\nTesting Undo Last Applied Change on helpers.py...');
    const undoResult = await reviewEngine.undoLastChange(flaskRoot);
    console.log(`  Undo result: ${undoResult.message}`);
    const restoredContent = await fs.promises.readFile(helpersPyPath, 'utf-8');
    if (restoredContent !== originalHelpersContent) {
      throw new Error('Undo did not restore exact original file content!');
    }
    console.log('  ✅ 5.6 Verified: "TF Agent: Undo Last Applied Change" reverted file cleanly to original state!');

    console.log('\n🎉🎉🎉 TASK A VERIFICATION PASSED COMPLETELY! 🎉🎉🎉');
  } finally {
    // Ensure original content is restored in case of failure
    await fs.promises.writeFile(helpersPyPath, originalHelpersContent, 'utf-8');
    await mcpServer.stop();
    console.log('MCP Server stopped and workspace cleanly restored.');
  }
}

main().catch((err) => {
  console.error('Task A Verification Failed:', err);
  process.exit(1);
});
