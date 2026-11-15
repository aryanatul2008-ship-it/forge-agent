import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeHunks, applyPartialHunks } from '../src/review/diff';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';

async function main() {
  console.log('=== Running Diff Review & Hunk Engine Unit Tests ===\n');

  // Test Suite 1: computeHunks
  console.log('--- Test Suite 1: computeHunks ---');

  // 1.1 Single line modification
  const orig1 = 'line 1\nline 2 original\nline 3';
  const new1 = 'line 1\nline 2 modified\nline 3';
  const hunks1 = computeHunks(orig1, new1);
  console.log(`1.1 Single line modification: ${hunks1.length} hunk(s) found`);
  if (hunks1.length !== 1) throw new Error('Expected 1 hunk');
  if (hunks1[0].oldStart !== 2 || hunks1[0].oldLines !== 1) {
    throw new Error(`Unexpected line numbers: oldStart=${hunks1[0].oldStart}, oldLines=${hunks1[0].oldLines}`);
  }
  console.log('  ✅ 1.1 Passed');

  // 1.2 Insertion of lines
  const orig2 = 'start\nend';
  const new2 = 'start\ninserted line A\ninserted line B\nend';
  const hunks2 = computeHunks(orig2, new2);
  console.log(`1.2 Insertion: ${hunks2.length} hunk(s) found`);
  if (hunks2.length !== 1) throw new Error('Expected 1 hunk');
  if (hunks2[0].newLines !== 2) throw new Error(`Expected 2 newLines, got ${hunks2[0].newLines}`);
  console.log('  ✅ 1.2 Passed');

  // 1.3 Deletion of lines
  const orig3 = 'line 1\nline 2 to delete\nline 3';
  const new3 = 'line 1\nline 3';
  const hunks3 = computeHunks(orig3, new3);
  console.log(`1.3 Deletion: ${hunks3.length} hunk(s) found`);
  if (hunks3.length !== 1) throw new Error('Expected 1 hunk');
  if (hunks3[0].oldLines !== 1 || hunks3[0].newLines !== 0) {
    throw new Error('Expected deletion hunk (oldLines=1, newLines=0)');
  }
  console.log('  ✅ 1.3 Passed');

  // 1.4 Multiple non-adjacent hunks
  const orig4 = [
    'line 1',
    'alpha original',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'beta original',
    'line 9',
  ].join('\n');

  const new4 = [
    'line 1',
    'alpha MODIFIED',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'beta MODIFIED',
    'line 9',
  ].join('\n');

  const hunks4 = computeHunks(orig4, new4, 1);
  console.log(`1.4 Non-adjacent hunks: ${hunks4.length} hunk(s) found`);
  if (hunks4.length !== 2) throw new Error(`Expected 2 separate hunks, got ${hunks4.length}`);
  if (hunks4[0].oldStart !== 2 || hunks4[1].oldStart !== 8) {
    throw new Error(`Unexpected start lines: hunk1=${hunks4[0].oldStart}, hunk2=${hunks4[1].oldStart}`);
  }
  console.log('  ✅ 1.4 Passed');

  // 1.5 Identical content
  const hunks5 = computeHunks('same\nsame', 'same\nsame');
  if (hunks5.length !== 0) throw new Error('Expected 0 hunks for identical text');
  console.log('  ✅ 1.5 Identical content returns 0 hunks');

  // Test Suite 2: Partial Apply
  console.log('\n--- Test Suite 2: applyPartialHunks ---');

  // 2.1 Accept all hunks
  hunks4[0].status = 'accepted';
  hunks4[1].status = 'accepted';
  const res2_1 = applyPartialHunks(orig4, hunks4);
  if (res2_1.newContent !== new4) throw new Error('Accept all should equal proposed new content');
  if (res2_1.appliedCount !== 2 || res2_1.rejectedCount !== 0) throw new Error('Count mismatch');
  console.log('  ✅ 2.1 Accept all hunks passed');

  // 2.2 Reject all hunks
  hunks4[0].status = 'rejected';
  hunks4[1].status = 'rejected';
  const res2_2 = applyPartialHunks(orig4, hunks4);
  if (res2_2.newContent !== orig4) throw new Error('Reject all should leave original untouched');
  if (res2_2.appliedCount !== 0 || res2_2.rejectedCount !== 2) throw new Error('Count mismatch');
  console.log('  ✅ 2.2 Reject all hunks passed');

  // 2.3 Partial apply: Accept Hunk 1, Reject Hunk 2
  hunks4[0].status = 'accepted';
  hunks4[1].status = 'rejected';
  const res2_3 = applyPartialHunks(orig4, hunks4);
  if (!res2_3.newContent.includes('alpha MODIFIED')) throw new Error('Hunk 1 should be applied');
  if (!res2_3.newContent.includes('beta original')) throw new Error('Hunk 2 should be rejected (beta original kept)');
  if (res2_3.newContent.includes('beta MODIFIED')) throw new Error('Hunk 2 should not be applied');
  console.log('  ✅ 2.3 Partial apply (Accept Hunk 1, Reject Hunk 2) passed');

  // 2.4 Partial apply: Reject Hunk 1, Accept Hunk 2
  hunks4[0].status = 'rejected';
  hunks4[1].status = 'accepted';
  const res2_4 = applyPartialHunks(orig4, hunks4);
  if (!res2_4.newContent.includes('alpha original')) throw new Error('Hunk 1 should remain original');
  if (!res2_4.newContent.includes('beta MODIFIED')) throw new Error('Hunk 2 should be applied');
  console.log('  ✅ 2.4 Partial apply (Reject Hunk 1, Accept Hunk 2) passed');

  // Test Suite 3: DiffReviewEngine Staging, Multiple Files, Repeated Edits, Stale Detection, & Undo
  console.log('\n--- Test Suite 3: DiffReviewEngine Workflows ---');

  const testDir = path.resolve(process.cwd(), 'dist', 'test-review-workspace');
  await fs.promises.mkdir(testDir, { recursive: true });
  WorkspaceRetrieval.setWorkspaceRoot(testDir);

  const fileA = 'moduleA.py';
  const fileB = 'moduleB.py';
  const fileAPath = path.join(testDir, fileA);
  const fileBPath = path.join(testDir, fileB);

  await fs.promises.writeFile(fileAPath, 'def func_a():\n    return "original_a"\n', 'utf-8');
  await fs.promises.writeFile(fileBPath, 'def func_b():\n    return "original_b"\n', 'utf-8');

  const engine = new DiffReviewEngine();

  // 3.1 Multiple files in one run
  console.log('3.1 Staging multiple files in one run...');
  const editA = await engine.stageEdit('call-1', fileA, 'Update func_a', {
    newContent: 'def func_a():\n    return "updated_a"\n',
  });
  const editB = await engine.stageEdit('call-2', fileB, 'Update func_b', {
    newContent: 'def func_b():\n    return "updated_b"\n',
  });

  if (engine.getAllStagedEdits().length !== 2) throw new Error('Expected 2 staged files');
  console.log('  ✅ 3.1 Successfully staged multiple files concurrently');

  // 3.2 A file edited twice (updating staged edit)
  console.log('3.2 Updating edit for fileA...');
  const editA2 = await engine.stageEdit('call-1-v2', fileA, 'Update func_a v2', {
    newContent: 'def func_a():\n    return "updated_a_v2"\n',
  });
  if (editA2.hunks[0].newText !== '    return "updated_a_v2"') {
    throw new Error('Expected updated hunk text');
  }
  console.log('  ✅ 3.2 Successfully handled repeated edit to same file');

  // 3.3 Apply edit to fileB with per-hunk approval
  console.log('3.3 Applying edit to fileB...');
  engine.setAllHunksDecision('call-2', 'accepted');
  const applyResB = await engine.applyApprovedEdit('call-2');
  console.log(`  Result: ${applyResB.summary}`);
  const contentBAfter = await fs.promises.readFile(fileBPath, 'utf-8');
  if (!contentBAfter.includes('updated_b')) throw new Error('fileB was not updated');
  console.log('  ✅ 3.3 Successfully applied accepted hunks to fileB');

  // 3.4 Undo Last Applied Change
  console.log('3.4 Testing Undo Last Applied Change...');
  const undoRes = await engine.undoLastChange(testDir);
  console.log(`  Undo message: ${undoRes.message}`);
  if (!undoRes.success) throw new Error('Undo should succeed');
  const contentBReverted = await fs.promises.readFile(fileBPath, 'utf-8');
  if (!contentBReverted.includes('original_b')) throw new Error('fileB was not reverted to original');
  console.log('  ✅ 3.4 Undo history stack successfully reverted fileB');

  // 3.5 Stale file detection
  console.log('3.5 Testing Stale File Detection...');
  // Modify fileA on disk after it was staged
  await fs.promises.writeFile(fileAPath, '# User made changes meanwhile\ndef func_a():\n    return "user_custom"\n', 'utf-8');

  // Try applying editA2
  engine.setAllHunksDecision('call-1-v2', 'accepted');
  const staleRes = await engine.applyApprovedEdit('call-1-v2');
  console.log(`  Stale result: ${staleRes.summary}`);
  if (!staleRes.isStale) throw new Error('Expected conflict/stale flag');
  if (staleRes.appliedCount !== 0) throw new Error('Stale edit should not apply any hunks');

  const contentAAfterConflict = await fs.promises.readFile(fileAPath, 'utf-8');
  if (!contentAAfterConflict.includes('user_custom')) {
    throw new Error('User changes were overwritten! Conflict detection failed.');
  }
  console.log('  ✅ 3.5 Stale file conflict correctly detected; user changes preserved');

  // Cleanup testDir
  await fs.promises.rm(testDir, { recursive: true, force: true });

  console.log('\n🎉 ALL DIFF REVIEW & HUNK ENGINE UNIT TESTS PASSED!');
}

main().catch((err) => {
  console.error('Unit test failed:', err);
  process.exit(1);
});
