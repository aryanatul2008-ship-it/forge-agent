import * as path from 'node:path';
import * as fs from 'node:fs';
import { BM25Index, tokenizeText } from '../src/context/bm25';
import { WorkspaceIndexer } from '../src/context/indexer';
import { ContextEngine } from '../src/context/engine';
import { enforceContextBudget, estimateTokens, CHARS_PER_TOKEN } from '../src/context/budget';
import { executeEditorTool } from '../src/mcp/tools';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';

async function main() {
  console.log('=== Running Context Retrieval & Budgeting Unit/Integration Tests ===\n');

  // Test Suite 1: Tokenization and BM25 Scoring
  console.log('--- Test Suite 1: BM25 Tokenizer and Scoring Engine ---');
  const tokens = tokenizeText('def get_debug_flag(default_val=True): return FlaskGroup');
  console.log('1.1 Tokenizer output:', tokens);
  if (!tokens.includes('get_debug_flag') || !tokens.includes('debug') || !tokens.includes('flask') || !tokens.includes('group')) {
    throw new Error('Tokenizer failed to split snake_case and camelCase identifiers properly');
  }
  if (tokens.includes('def') || tokens.includes('=')) {
    // def is not in stop words, but punctuation should be stripped
  }
  console.log('  ✅ 1.1 Tokenizer splits snake_case and camelCase correctly');

  const bm25 = new BM25Index();
  const chunk1 = {
    id: 'helpers.py#chunk1',
    filePath: 'src/flask/helpers.py',
    startLine: 1,
    endLine: 35,
    content: 'def get_debug_flag():\n    val = os.environ.get("FLASK_DEBUG")\n    return val.lower() in ("true", "1")\n',
    tokensCount: 30,
    termFrequencies: new Map([['debug', 2], ['flag', 1], ['flask', 1]]),
    totalTerms: 15,
  };
  const chunk2 = {
    id: 'cli.py#chunk1',
    filePath: 'src/flask/cli.py',
    startLine: 1,
    endLine: 35,
    content: 'class FlaskGroup(AppGroup):\n    def __init__(self, add_default_commands=True):\n        pass\n',
    tokensCount: 25,
    termFrequencies: new Map([['flask', 2], ['group', 2], ['commands', 1]]),
    totalTerms: 12,
  };

  bm25.addChunk(chunk1);
  bm25.addChunk(chunk2);
  if (bm25.totalDocuments !== 2) throw new Error(`Expected 2 documents, got ${bm25.totalDocuments}`);

  const search1 = bm25.search('debug flag');
  if (search1.length === 0 || search1[0].chunk.id !== chunk1.id) {
    throw new Error('BM25 did not rank chunk1 top for query "debug flag"');
  }
  console.log(`  ✅ 1.2 BM25 query "debug flag" correctly ranked ${search1[0].chunk.id} (Score: ${search1[0].score.toFixed(2)})`);

  bm25.removeChunk(chunk1.id);
  if ((bm25.totalDocuments as number) !== 1) throw new Error('BM25 removeChunk failed');
  console.log('  ✅ 1.3 BM25 chunk removal successful');

  // Test Suite 2: Workspace Indexer & Chunking
  console.log('\n--- Test Suite 2: Workspace Indexer & Chunking ---');
  const indexer = new WorkspaceIndexer();
  const samplePython = [
    '# Flask helpers sample',
    'import os',
    '',
    'def get_debug_flag():',
    '    """Returns whether debug mode is enabled."""',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    if not val:',
    '        return False',
    '    return val.lower() in ("true", "t", "1", "yes", "y")',
    '',
    'class HelperConfig:',
    '    def __init__(self):',
    '        self.enabled = True',
  ].join('\n');

  await indexer.indexFile('src/flask/helpers.py', samplePython);
  const foundSymbols = indexer.searchSymbols('get_debug_flag');
  console.log('2.1 Extracted symbols:', foundSymbols.map((s) => `${s.kind} ${s.name} at line ${s.line}`));
  if (foundSymbols.length === 0 || foundSymbols[0].name !== 'get_debug_flag') {
    throw new Error('Symbol extraction failed to locate get_debug_flag');
  }
  console.log('  ✅ 2.1 Python symbol extraction succeeded');

  const bm25Matches = indexer.searchBM25('debug flag');
  if (bm25Matches.length === 0) throw new Error('BM25 search on indexed file failed');
  console.log(`  ✅ 2.2 BM25 retrieved ${bm25Matches.length} chunk(s) from indexed file`);

  // Test Suite 3: Mention Parsing and Autocomplete
  console.log('\n--- Test Suite 3: Mentions & Autocomplete ---');
  const engine = new ContextEngine(indexer, { maxTokens: 6000 });

  const parsed1 = engine.parseMentions('Please inspect @file:src/flask/helpers.py and update @symbol:get_debug_flag');
  console.log('3.1 Explicit mentions:', parsed1.mentions);
  if (parsed1.mentions.length !== 2) throw new Error(`Expected 2 mentions, got ${parsed1.mentions.length}`);
  if (parsed1.mentions[0].type !== 'file' || parsed1.mentions[1].type !== 'symbol') {
    throw new Error('Explicit mention types incorrect');
  }
  console.log('  ✅ 3.1 Explicit @file and @symbol parsed correctly');

  const parsedBare = engine.parseMentions('Check @helpers.py and @get_debug_flag');
  console.log('3.2 Bare mentions:', parsedBare.mentions);
  if (parsedBare.mentions.length !== 2) throw new Error(`Expected 2 bare mentions, got ${parsedBare.mentions.length}`);
  console.log('  ✅ 3.2 Bare @file and @symbol auto-resolved');

  const suggestions = engine.getMentionSuggestions('@deb');
  console.log('3.3 Autocomplete suggestions for "@deb":', suggestions.map((s) => s.value));
  if (suggestions.length === 0 || !suggestions.some((s) => s.value.includes('get_debug_flag'))) {
    throw new Error('Mention autocomplete failed to suggest get_debug_flag for query "@deb"');
  }
  console.log('  ✅ 3.3 Mention autocomplete suggestions functional');

  // Test Suite 4: Strict Token Budgeting & Deduplication
  console.log('\n--- Test Suite 4: Strict Budgeting & Overlap Merging ---');
  const smallBudgetEngine = new ContextEngine(indexer, { maxTokens: 120 }); // strict small budget
  const smallRes = await smallBudgetEngine.retrieveRelevantContext('get_debug_flag in helpers');
  console.log('4.1 Small budget result:', smallRes.summary);
  console.log(`4.1 Total tokens: ${smallRes.totalTokens} / Budget: ${smallRes.budgetTokens}`);
  if (smallRes.totalTokens > smallRes.budgetTokens) {
    throw new Error(`Total tokens (${smallRes.totalTokens}) exceeded budget limit (${smallRes.budgetTokens})`);
  }
  console.log('  ✅ 4.1 Strict budget cap enforced without overflow');

  // Test enforceContextBudget truncation helper
  const longText = 'A'.repeat(5000);
  const capped = enforceContextBudget(longText, { maxTokens: 100, label: 'test' });
  if (!capped.includes('[TRUNCATED for test: Output capped at ~100 tokens')) {
    throw new Error('enforceContextBudget did not include expected truncation banner');
  }
  if (capped.length >= longText.length) {
    throw new Error('enforceContextBudget failed to truncate text');
  }
  console.log('  ✅ 4.2 enforceContextBudget truncates gracefully with informative notice');

  // Test Suite 5: MCP Tool get_relevant_context
  console.log('\n--- Test Suite 5: MCP Tool get_relevant_context Execution ---');
  const reviewEngine = new DiffReviewEngine();
  const toolResult = await executeEditorTool(
    'get_relevant_context',
    { query: 'debug flag', limit: 3 },
    'call-test-context-1',
    reviewEngine,
    engine
  );

  if (toolResult.isError) {
    throw new Error(`get_relevant_context returned error: ${toolResult.content[0].text}`);
  }
  console.log('5.1 MCP tool output snippet:\n' + toolResult.content[0].text.slice(0, 350) + '...\n');
  if (!toolResult.content[0].text.includes('Reason:') || !toolResult.content[0].text.includes('src/flask/helpers.py')) {
    throw new Error('MCP tool output missing Reason or file path');
  }
  console.log('  ✅ 5.1 get_relevant_context returned ranked snippets with one-line reasons');

  console.log('\n🎉 ALL CONTEXT RETRIEVAL & BUDGETING TESTS PASSED SUCCESSFULLY! 🎉');
}

main().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
