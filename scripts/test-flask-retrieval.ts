import { WorkspaceRetrieval } from '../src/context/retrieval';

async function main() {
  const flaskRoot = 'C:\\dev\\flask';
  console.log(`Setting workspace root to: ${flaskRoot}`);
  WorkspaceRetrieval.setWorkspaceRoot(flaskRoot);

  console.log('\n--- Test 1: findSymbol("get_debug_flag") ---');
  const symbolResult = await WorkspaceRetrieval.findSymbol('get_debug_flag');
  console.log(symbolResult);

  if (!symbolResult.includes('helpers.py') || !symbolResult.includes('28')) {
    throw new Error('findSymbol failed to locate get_debug_flag at src/flask/helpers.py:28');
  }
  console.log('✅ Test 1 Passed: findSymbol correctly located get_debug_flag');

  console.log('\n--- Test 2: searchWorkspace("get_debug_flag") ---');
  const searchResult = await WorkspaceRetrieval.searchWorkspace('get_debug_flag', { maxResults: 5 });
  console.log(searchResult);

  if (!searchResult.includes('helpers.py')) {
    throw new Error('searchWorkspace failed to find occurrences in helpers.py');
  }
  console.log('✅ Test 2 Passed: searchWorkspace returned ranked results');

  console.log('\n--- Test 3: readFile("src/flask/helpers.py", 25, 35) ---');
  const readResult = await WorkspaceRetrieval.readFile('src/flask/helpers.py', 25, 35);
  console.log(readResult);

  if (!readResult.includes('def get_debug_flag() -> bool:')) {
    throw new Error('readFile failed to read get_debug_flag definition lines');
  }
  console.log('✅ Test 3 Passed: readFile returned targeted lines');

  console.log('\n--- Test 4: listDir("src/flask", 1) ---');
  const listResult = await WorkspaceRetrieval.listDir('src/flask', 1);
  console.log(listResult);

  if (!listResult.includes('helpers.py')) {
    throw new Error('listDir failed to list helpers.py in src/flask');
  }
  console.log('✅ Test 4 Passed: listDir returned directory listing');

  console.log('\n🎉 ALL RETRIEVAL TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});

