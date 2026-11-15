import { TrueForgeClient } from '../src/trueforge/client';

const TRUEFORGE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8791';
const MODEL_NAME = process.env.MODEL_NAME || 'google-gemini/gemini-3-1-flash-lite';

async function main() {
  console.log('=====================================================');
  console.log('🧪 Testing TrueForgeClient: Immediate Cancel');
  console.log('=====================================================\n');

  const client = new TrueForgeClient({
    baseUrl: TRUEFORGE_URL,
    models: [MODEL_NAME],
  });

  const sessionId = await client.createSession({
    modelName: MODEL_NAME,
    systemPrompt: 'You are an author. Write a very long story.',
  });

  console.log(`✅ Session created: ${sessionId}`);
  console.log('Starting long turn...');

  let cancelTriggered = false;
  let finalStatus = '';

  const turnPromise = client.streamTurn(
    sessionId,
    'Write a 3000 word detailed novel about the history of mathematics.',
    {
      onTurnCreated: (turnId) => {
        console.log(`  [TurnCreated] ID: ${turnId}`);
      },
      onDelta: async (content) => {
        if (!cancelTriggered) {
          cancelTriggered = true;
          console.log('\n  >> First token received! Calling client.cancelTurn()...');
          await client.cancelTurn(sessionId);
          console.log('  >> cancelTurn completed.');
        }
      },
      onStatusUpdate: (status) => {
        console.log(`  [Status] ${status}`);
      },
      onDone: (status, reason) => {
        finalStatus = status;
        console.log(`  [TurnDone] Status: "${status}", Reason: "${reason || 'none'}"`);
      },
    }
  );

  const res = await turnPromise;
  console.log('\nTurn result:', res);

  if (res.status !== 'cancelled' && finalStatus !== 'cancelled') {
    throw new Error('Expected status to be cancelled!');
  }

  console.log('🎉 Cancel test passed successfully!');
}

main().catch((err) => {
  console.error('Fatal error in cancel test:', err);
  process.exit(1);
});

