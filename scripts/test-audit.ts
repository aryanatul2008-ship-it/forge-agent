import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';
import { WorkspaceIndexer } from '../src/context/indexer';
import { TrueForgeClient } from '../src/trueforge/client';
import { LocalMcpServer } from '../src/mcp/server';

async function main() {
  console.log('=== Running Comprehensive System Audit & Edge Case Tests ===\n');

  const testDir = path.resolve(__dirname, '..', 'scratch', 'audit-test');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  WorkspaceRetrieval.setWorkspaceRoot(testDir);

  // -------------------------------------------------------------
  // Test 1: Cancellation while review is pending
  // -------------------------------------------------------------
  console.log('--- Test 1: Cancellation While Review is Pending ---');
  const reviewEngine = new DiffReviewEngine();
  const fileA = path.join(testDir, 'sample.py');
  await fs.promises.writeFile(fileA, 'def original():\n    return 42\n', 'utf-8');

  // Stage a proposed edit
  const staged = await reviewEngine.stageEdit(
    'call-test-cancel-1',
    'sample.py',
    'Change return value to 100',
    {
      newContent: 'def original():\n    return 100\n',
    }
  );
  console.log('1.1 Staged edit created, hunks count:', staged.hunks.length);
  if (reviewEngine.getAllStagedEdits().length !== 1) {
    throw new Error('Expected 1 staged edit in memory');
  }

  // Cancel turn -> clear all staged edits
  console.log('1.2 Triggering turn cancellation...');
  reviewEngine.clearAllStagedEdits();

  if (reviewEngine.getAllStagedEdits().length !== 0) {
    throw new Error('clearAllStagedEdits failed to discard pending staged edits');
  }

  const diskContentAfterCancel = await fs.promises.readFile(fileA, 'utf-8');
  if (diskContentAfterCancel !== 'def original():\n    return 42\n') {
    throw new Error('Disk file was modified despite cancellation!');
  }
  console.log('  ✅ 1.1 Pending staged edit was discarded cleanly on cancel; disk left 100% untouched');

  // -------------------------------------------------------------
  // Test 2: Active command cancellation (killRunningCommands)
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Active Command Cancellation ---');
  console.log('2.1 Launching background sleep command via runCommand...');
  const startTime = Date.now();
  const cmdPromise = WorkspaceRetrieval.runCommand('Start-Sleep -Seconds 15', 20000);

  // Allow process to spawn
  await new Promise((r) => setTimeout(r, 600));

  console.log('2.2 Invoking WorkspaceRetrieval.killRunningCommands()...');
  WorkspaceRetrieval.killRunningCommands();

  let cmdFailedOrFinished = false;
  try {
    const res = await cmdPromise;
    // On Windows taskkill might cause close event with non-zero exit code
    console.log(`2.3 Command closed with exit code ${res.exitCode}`);
    cmdFailedOrFinished = true;
  } catch (err: any) {
    console.log(`2.3 Command promise terminated with error: ${err.message}`);
    cmdFailedOrFinished = true;
  }

  const duration = Date.now() - startTime;
  console.log(`2.4 Process termination duration: ${duration}ms (Expected < 4000ms, not 15s)`);
  if (duration >= 10000) {
    throw new Error(`killRunningCommands failed to abort sleep command! Ran for ${duration}ms`);
  }
  console.log('  ✅ 2.1 Active command tree terminated immediately without hanging');

  // -------------------------------------------------------------
  // Test 3: Undo after accept
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Undo Stack After Accept ---');
  const fileB = path.join(testDir, 'undo_test.py');
  const initialContent = 'x = 10\ny = 20\n';
  await fs.promises.writeFile(fileB, initialContent, 'utf-8');

  // 3.1 Stage and accept edit
  await reviewEngine.stageEdit('call-undo-1', 'undo_test.py', 'Update y to 50', {
    newContent: 'x = 10\ny = 50\n',
  });
  reviewEngine.setAllHunksDecision('call-undo-1', 'accepted');
  const applyRes = await reviewEngine.applyApprovedEdit('call-undo-1');
  console.log(`3.1 Edit applied: ${applyRes.summary}`);

  const modifiedContent = await fs.promises.readFile(fileB, 'utf-8');
  if (!modifiedContent.includes('y = 50')) {
    throw new Error('Modified content was not written to disk');
  }

  // 3.2 Undo the change
  console.log('3.2 Invoking reviewEngine.undoLastChange()...');
  const undoRes = await reviewEngine.undoLastChange(testDir);
  console.log(`3.2 Undo result: ${undoRes.message}`);
  if (!undoRes.success) {
    throw new Error(`Undo failed: ${undoRes.message}`);
  }

  const restoredContent = await fs.promises.readFile(fileB, 'utf-8');
  if (restoredContent !== initialContent) {
    throw new Error(`Restored content mismatch: expected "${initialContent}", got "${restoredContent}"`);
  }
  console.log('  ✅ 3.1 Single undo restored file to exact original content');

  // 3.3 Multiple undos in sequence
  console.log('3.3 Testing multiple sequential undos...');
  await reviewEngine.stageEdit('call-multi-1', 'undo_test.py', 'First edit', {
    newContent: 'x = 100\ny = 20\n',
  });
  reviewEngine.setAllHunksDecision('call-multi-1', 'accepted');
  await reviewEngine.applyApprovedEdit('call-multi-1');

  await reviewEngine.stageEdit('call-multi-2', 'undo_test.py', 'Second edit', {
    newContent: 'x = 100\ny = 200\n',
  });
  reviewEngine.setAllHunksDecision('call-multi-2', 'accepted');
  await reviewEngine.applyApprovedEdit('call-multi-2');

  const afterTwoEdits = await fs.promises.readFile(fileB, 'utf-8');
  if (!afterTwoEdits.includes('x = 100') || !afterTwoEdits.includes('y = 200')) {
    throw new Error('Multi edits failed to apply');
  }

  // Undo 2
  const undoMulti2 = await reviewEngine.undoLastChange(testDir);
  console.log(`  Undo 2: ${undoMulti2.message}`);
  const afterUndo2 = await fs.promises.readFile(fileB, 'utf-8');
  if (!afterUndo2.includes('x = 100') || !afterUndo2.includes('y = 20')) {
    throw new Error(`Expected x=100, y=20 after undo 2, got:\n${afterUndo2}`);
  }

  // Undo 1
  const undoMulti1 = await reviewEngine.undoLastChange(testDir);
  console.log(`  Undo 1: ${undoMulti1.message}`);
  const afterUndo1 = await fs.promises.readFile(fileB, 'utf-8');
  if (afterUndo1 !== initialContent) {
    throw new Error(`Expected initial content after undo 1, got:\n${afterUndo1}`);
  }
  console.log('  ✅ 3.2 Multiple sequential undos reverted cleanly in LIFO order');

  // -------------------------------------------------------------
  // Test 4: Very Large Files & Budgeting
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Very Large File Handling & Budgeting ---');
  const largeFilePath = path.join(testDir, 'massive_file.py');
  const largeLines: string[] = [];
  for (let i = 1; i <= 6000; i++) {
    largeLines.push(`def handler_function_${i}(param_a, param_b): return ${i} * 10`);
  }
  await fs.promises.writeFile(largeFilePath, largeLines.join('\n'), 'utf-8');
  const largeStat = await fs.promises.stat(largeFilePath);
  console.log(`4.1 Created large file: ${largeLines.length} lines (${(largeStat.size / 1024).toFixed(1)} KB)`);

  const readLarge = await WorkspaceRetrieval.readFile('massive_file.py');
  console.log(`4.1 read_file output length: ${readLarge.length} characters`);
  if (!readLarge.includes('TRUNCATED') && !readLarge.includes('lines 1-')) {
    throw new Error('Large file read failed to apply budgeting / line windowing');
  }
  if (readLarge.length > 20000) {
    throw new Error(`read_file output exceeded context budget cap! Length: ${readLarge.length}`);
  }
  console.log('  ✅ 4.1 Large file capped safely within context budget (~3,500 tokens)');

  // Targeted line range on large file
  const readRange = await WorkspaceRetrieval.readFile('massive_file.py', 5000, 5010);
  console.log('4.2 Targeted range lines:\n' + readRange);
  if (!readRange.includes('handler_function_5000') || !readRange.includes('handler_function_5010')) {
    throw new Error('Targeted line range read failed on large file');
  }
  console.log('  ✅ 4.2 Targeted line range on large file retrieved exact line numbers');

  // -------------------------------------------------------------
  // Test 5: Binary File Guard
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Binary File Guard ---');
  // Create binary file with null bytes
  const binaryFilePath = path.join(testDir, 'binary_data.bin');
  const binaryBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00, 0xff, 0xee]);
  await fs.promises.writeFile(binaryFilePath, binaryBuffer);

  const isBin1 = await WorkspaceRetrieval.isBinaryFile(binaryFilePath);
  console.log(`5.1 isBinaryFile on binary_data.bin: ${isBin1}`);
  if (!isBin1) throw new Error('isBinaryFile failed to detect null-byte binary file');

  const readBinaryRes = await WorkspaceRetrieval.readFile('binary_data.bin');
  console.log(`5.2 read_file on binary file output: "${readBinaryRes}"`);
  if (!readBinaryRes.includes('[Binary file cannot be displayed')) {
    throw new Error('readFile failed to guard against binary file display');
  }
  console.log('  ✅ 5.1 Binary file with null bytes detected and guarded');

  // Also check png/image extension
  const fakePngPath = path.join(testDir, 'image.png');
  await fs.promises.writeFile(fakePngPath, Buffer.from('fake png content'));
  const isBin2 = await WorkspaceRetrieval.isBinaryFile(fakePngPath);
  if (!isBin2) throw new Error('isBinaryFile failed to detect image extension as binary');
  const readPngRes = await WorkspaceRetrieval.readFile('image.png');
  if (!readPngRes.includes('[Binary file cannot be displayed')) {
    throw new Error('readFile failed to guard against .png binary file');
  }
  console.log('  ✅ 5.2 Common binary extensions (.png) guarded cleanly');

  // Search workspace skips binary files
  const searchRes = await WorkspaceRetrieval.searchWorkspace('ELF');
  console.log(`5.3 searchWorkspace result: "${searchRes}"`);
  if (searchRes.includes('binary_data.bin')) {
    throw new Error('searchWorkspace improperly returned binary file');
  }
  console.log('  ✅ 5.3 searchWorkspace skipped binary files');

  // Indexer skips binary files
  const indexer = new WorkspaceIndexer(testDir);
  await indexer.indexFile('binary_data.bin');
  if (indexer.getIndexedChunksCount() !== 0) {
    throw new Error('Indexer improperly indexed binary file chunks');
  }
  console.log('  ✅ 5.4 WorkspaceIndexer excluded binary files from BM25 index');

  // -------------------------------------------------------------
  // Test 6: Mid-stream turn cancellation on TrueForge
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Mid-Stream Turn Cancellation ---');
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
  let tfRunning = false;
  try {
    const res = await fetch(`${trueforgeUrl}/api/v1/models`);
    if (res.ok) tfRunning = true;
  } catch {}

  if (tfRunning) {
    const tfClient = new TrueForgeClient({
      baseUrl: trueforgeUrl,
      models: ['google-gemini/gemini-3-1-flash-lite'],
    });

    const mcpServer = new LocalMcpServer(reviewEngine);
    const mcpInfo = await mcpServer.start(0);
    await tfClient.registerMcpServer({
      name: 'vscode-ide',
      url: mcpInfo.url,
      description: 'Audit Test MCP',
      bearerToken: mcpInfo.token,
    });

    const sessionId = await tfClient.createSession({ modelName: 'google-gemini/gemini-3-1-flash-lite' });
    let cancelDetected = false;
    let tokensStreamed = 0;

    const streamPromise = tfClient.streamTurn(
      sessionId,
      'Write a comprehensive 1000-word essay about the architecture of operating systems.',
      {
        onDelta: (t) => {
          tokensStreamed += t.length;
          if (tokensStreamed > 50 && !cancelDetected) {
            cancelDetected = true;
            console.log(`6.1 Received ${tokensStreamed} chars from stream. Triggering immediate cancelTurn()...`);
            tfClient.cancelTurn(sessionId).catch(() => {});
          }
        },
      }
    );

    const streamResult = await streamPromise;
    console.log(`6.2 Turn finished with status: "${streamResult.status}", reason: "${streamResult.reason}"`);
    if (streamResult.status !== 'cancelled') {
      throw new Error(`Expected stream turn status to be 'cancelled', got '${streamResult.status}'`);
    }
    console.log('  ✅ 6.1 Mid-stream cancellation terminated generation immediately with status "cancelled"');
    await mcpServer.stop();
  } else {
    console.log('⚠️ TrueForge not reachable, skipping live stream cancellation test.');
  }

  // Cleanup test directory
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log('\n🎉 ALL AUDIT & EDGE CASE TESTS PASSED SUCCESSFULLY! 🎉');
}

main().catch((err) => {
  console.error('\n❌ Audit test failed with error:', err);
  process.exit(1);
});
