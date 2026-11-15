import { TrueForgeClient } from '../src/trueforge/client.js';

const TRUEFORGE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8791';
const MODEL_NAME = process.env.MODEL_NAME || 'google-gemini/gemini-3-1-flash-lite';

async function main() {
  console.log('=====================================================');
  console.log('🧪 Testing TrueForgeClient: Plain Question (No Tools)');
  console.log(`Connecting to: ${TRUEFORGE_URL}`);
  console.log(`Model: ${MODEL_NAME}`);
  console.log('=====================================================\n');

  const client = new TrueForgeClient({
    baseUrl: TRUEFORGE_URL,
    models: [MODEL_NAME],
  });

  console.log('1. Creating session...');
  const sessionId = await client.createSession({
    modelName: MODEL_NAME,
    systemPrompt: 'You are a helpful coding assistant. Answer concisely in one sentence.',
  });
  console.log(`✅ Session created: ${sessionId}\n`);

  console.log('2. Streaming plain question: "What is 15 * 4? Answer in one sentence."');
  let accumulatedResponse = '';
  let statusLines: string[] = [];

  const result = await client.streamTurn(
    sessionId,
    'What is 15 * 4? Answer in one sentence.',
    {
      onTurnCreated: (turnId) => {
        console.log(`  [TurnCreated] ID: ${turnId}`);
      },
      onDelta: (content) => {
        accumulatedResponse += content;
        process.stdout.write(content);
      },
      onStatusUpdate: (status, details) => {
        statusLines.push(`[Status: ${status}] ${details || ''}`);
      },
      onDone: (status, reason, metrics) => {
        console.log(`\n\n  [TurnDone] Status: ${status}, Reason: ${reason || 'none'}`);
        if (metrics) {
          console.log(`  [Metrics] Total tokens: ${metrics.totalTokens || 'N/A'}`);
        }
      },
      onError: (err) => {
        console.error(`  [Error] ${err.message}`);
      },
    }
  );

  console.log('\n=====================================================');
  console.log('Recorded Status Lines:');
  for (const s of statusLines) {
    console.log('  •', s);
  }
  console.log('Final Accumulated Text:', accumulatedResponse.trim());
  console.log('Turn Status:', result.status);
  console.log('=====================================================');

  if (result.status !== 'done' || accumulatedResponse.length === 0) {
    throw new Error('Plain turn test failed!');
  }

  console.log('🎉 Plain question test passed successfully!');
}

main().catch((err) => {
  console.error('Fatal error in plain turn test:', err);
  process.exit(1);
});
