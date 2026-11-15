import { LocalMcpServer } from '../src/mcp/server';
import { DiffReviewEngine } from '../src/review/diffReview';
import { WorkspaceRetrieval } from '../src/context/retrieval';
import { TrueForgeClient } from '../src/trueforge/client';
import { ToolCallInfo, ToolResponseInfo } from '../src/trueforge/types';

async function main() {
  const flaskRoot = 'C:\\dev\\flask';
  const trueforgeUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8791';
  console.log(`[TEST] Targeting Flask workspace: ${flaskRoot}`);
  console.log(`[TEST] Using TrueForge at: ${trueforgeUrl}`);

  WorkspaceRetrieval.setWorkspaceRoot(flaskRoot);

  // 1. Start Local MCP Server
  console.log('\n⏳ [1/4] Starting Local MCP Server...');
  const reviewEngine = new DiffReviewEngine();
  const mcpServer = new LocalMcpServer(reviewEngine);
  const mcpInfo = await mcpServer.start(8795);
  console.log(`✅ [1/4] Local MCP Server running on port ${mcpInfo.port} (${mcpInfo.url})`);

  // 2. Initialize TrueForge Client & Register MCP Server
  console.log('\n⏳ [2/4] Registering MCP server with TrueForge...');
  const tfClient = new TrueForgeClient({
    baseUrl: trueforgeUrl,
    models: ['google-gemini/gemini-3-1-flash-lite'],
  });

  await tfClient.registerMcpServer({
    name: 'vscode-ide',
    url: mcpInfo.url,
    description: 'Local VS Code IDE capabilities for Flask repository',
    bearerToken: mcpInfo.token,
  });
  console.log('✅ [2/4] MCP server "vscode-ide" registered in TrueForge');

  // 3. Create Session with Inline Agent Spec
  console.log('\n⏳ [3/4] Creating session with inline spec from agent/agent.config.json...');
  const sessionId = await tfClient.createSession({
    mcpServerName: 'vscode-ide',
  });
  console.log(`✅ [3/4] Session created: ${sessionId}`);

  // 4. Send Prompt: "where is get_debug_flag defined?"
  const prompt = 'where is get_debug_flag defined?';
  console.log(`\n⏳ [4/4] Sending user prompt: "${prompt}"...`);

  const observedToolCalls: ToolCallInfo[] = [];
  const observedToolResponses: ToolResponseInfo[] = [];
  let accumulatedResponse = '';

  try {
    await tfClient.streamTurn(sessionId, prompt, {
      onEvent: (event) => {
        if (!event.type.includes('delta')) {
          console.log(`  [EVENT] ${event.type}`);
        }
      },
      onTurnCreated: (turnId) => {
        console.log(`  [TURN CREATED] Turn ID: ${turnId}`);
      },
      onDelta: (content) => {
        process.stdout.write(content);
        accumulatedResponse += content;
      },
      onToolCall: (call) => {
        console.log(`\n  [TOOL CALL] ID: ${call.id} | Tool: ${call.name} | Args:`, JSON.stringify(call.arguments));
        observedToolCalls.push(call);
      },
      onToolResponse: (resp) => {
        console.log(`\n  [TOOL RESPONSE] ID: ${resp.toolCallId} | Content:`);
        const preview = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        console.log(preview.slice(0, 300) + (preview.length > 300 ? '...' : ''));
        observedToolResponses.push(resp);
      },
      onStatusUpdate: (status, details) => {
        console.log(`\n  [STATUS] ${status}${details ? ` (${details})` : ''}`);
      },
      onDone: (status, reason, metrics) => {
        console.log(`\n  [TURN DONE] Status: ${status} | Reason: ${reason ?? 'none'} | Tokens: ${metrics?.totalTokens ?? 'N/A'}`);
      },
      onError: (err) => {
        console.error(`\n  [TURN ERROR]`, err);
      },
    });

    console.log('\n\n--- Verification Summary ---');
    console.log(`Total tool calls recorded: ${observedToolCalls.length}`);
    console.log(`Total tool responses recorded: ${observedToolResponses.length}`);

    if (observedToolCalls.length === 0 && observedToolResponses.length === 0) {
      throw new Error('Agent failed to invoke any MCP tools!');
    }

    const hasFlaskHelper =
      accumulatedResponse.includes('helpers.py') ||
      accumulatedResponse.includes('src/flask/helpers.py');

    if (!hasFlaskHelper) {
      console.warn('⚠️ Warning: Final response did not explicitly mention helpers.py. Full text:');
      console.warn(accumulatedResponse);
      throw new Error('Agent response did not identify src/flask/helpers.py');
    }

    console.log('\n🎉 SUCCESS: Agent successfully used local MCP tools to discover get_debug_flag definition in Flask!');
  } finally {
    console.log('\nStopping Local MCP Server...');
    await mcpServer.stop();
    console.log('Local MCP Server stopped.');
  }
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

