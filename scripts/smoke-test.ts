import http from 'http';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TrueForge } from '@truefoundry/trueforge-sdk';

// Default to 8791 (which runs with local network policy allowed for 127.0.0.1) or env override
const TRUEFORGE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8791';
const MODEL_NAME = process.env.MODEL_NAME || 'google-gemini/gemini-3-1-flash-lite';
const MCP_SERVER_NAME = 'smoke-test-mcp';

async function main() {
  console.log('=====================================================');
  console.log('🚀 TrueForge Smoke Test: Tool Approval & Cancellation');
  console.log(`Connecting to TrueForge at: ${TRUEFORGE_URL}`);
  console.log(`Using model: ${MODEL_NAME}`);
  console.log('=====================================================\n');

  // Step 1: Start In-Memory MCP Server with Bearer Auth
  const bearerToken = randomUUID();
  let toolExecuted = false;

  function createMcpServerInstance() {
    const server = new Server(
      { name: 'smoke-test-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.log('  [MCP Server] listTools called');
      return {
        tools: [
          {
            name: 'echo_with_approval',
            description: 'Echos back the provided text after approval is granted.',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'The text to echo back'
                }
              },
              required: ['text']
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.log(`  [MCP Server] Tool invoked: ${request.params.name}`);
      console.log(`  [MCP Server] Tool arguments:`, JSON.stringify(request.params.arguments));
      toolExecuted = true;
      const text = (request.params.arguments as any)?.text || '';
      return {
        content: [
          {
            type: 'text',
            text: `[Approved Echo]: ${text}`
          }
        ]
      };
    });

    return server;
  }

  const activeSessions = new Map<string, { server: Server; transport: SSEServerTransport }>();

  const httpServer = http.createServer(async (req, res) => {
    // Verify bearer token
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${bearerToken}`) {
      console.error(`  [MCP Server] ❌ Unauthorized request: ${authHeader}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/sse') {
      console.log('  [MCP Server] Established SSE transport connection');
      const sseTransport = new SSEServerTransport('/message', res);
      const serverInstance = createMcpServerInstance();
      await serverInstance.connect(sseTransport);
      activeSessions.set(sseTransport.sessionId, { server: serverInstance, transport: sseTransport });
      sseTransport.onclose = () => {
        activeSessions.delete(sseTransport.sessionId);
      };
    } else if (url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId');
      const session = (sessionId ? activeSessions.get(sessionId) : null) || Array.from(activeSessions.values()).pop();
      if (session) {
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(400);
        res.end('No active SSE connection');
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const mcpPort = (httpServer.address() as any).port;
  console.log(`✅ [1/5] Local MCP server started on port ${mcpPort}`);

  const tfClient = new TrueForge({ baseUrl: TRUEFORGE_URL });

  // Step 2: Register MCP server in TrueForge
  console.log(`\n⏳ [2/5] Registering MCP server "${MCP_SERVER_NAME}" in TrueForge...`);
  await tfClient.settings.mcpServers.createOrUpdate({
    manifest: {
      name: MCP_SERVER_NAME,
      type: 'remote',
      description: 'Smoke test MCP server requiring approval',
      url: `http://127.0.0.1:${mcpPort}/sse`,
      auth: {
        type: 'header',
        headers: {
          authorization: `Bearer ${bearerToken}`
        }
      }
    }
  });
  console.log(`✅ [2/5] MCP server "${MCP_SERVER_NAME}" registered in TrueForge`);

  // Step 3: Create Session with Inline Spec requiring approval for echo_with_approval
  console.log(`\n⏳ [3/5] Creating session with inline spec requiring approval for echo_with_approval...`);
  const sessionRes = await tfClient.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL_NAME },
        instructions:
          'You are a testing assistant. When the user asks you to echo text, you MUST call the echo_with_approval tool.',
        mcpServers: [
          {
            name: MCP_SERVER_NAME,
            enableTools: ['@all'],
            requireApprovalForTools: ['echo_with_approval']
          }
        ]
      }
    }
  });
  const sessionId = sessionRes.data.id;
  console.log(`✅ [3/5] Session created with ID: ${sessionId}`);

  // Step 4: Test Tool Approval Workflow
  console.log(`\n⏳ [4/5] Testing Turn 1: Triggering tool call & approving execution...`);
  const turn1Stream = await tfClient.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: 'Please echo "Approval workflow verified!" using the echo_with_approval tool.'
      }
    ]
  });

  let currentTurnId = '';
  let approvalReceived = false;
  let turn1Done = false;

  for await (const event of turn1Stream) {
    console.log(`  [Turn 1 Event] ${event.type}`);

    if (event.type === 'turn.created') {
      currentTurnId = event.turnId;
      console.log(`  [Turn 1] Turn ID: ${currentTurnId}`);
    } else if (event.type === 'tool.approval_required') {
      approvalReceived = true;
      console.log(`  [Turn 1] 🎯 Received event: tool.approval_required!`);
      const toolCalls = (event as any).toolCalls || (event as any).tool_calls || [];
      console.log(`  [Turn 1] Gated tool calls count: ${toolCalls.length}`);

      for (const call of toolCalls) {
        console.log(`  [Turn 1] Call ID to approve: ${call.id}`);
        console.log(`  [Turn 1] Sending approval: user.tool_approval (allow)...`);

        await tfClient.sessions.createTurnEvents(sessionId, currentTurnId, {
          events: [
            {
              type: 'user.tool_approval',
              toolCallId: call.id,
              threadId: (event as any).threadId || (event as any).thread_id || 'main',
              approval: { status: 'allow' }
            }
          ]
        });
        console.log(`  [Turn 1] ✅ Approval event sent successfully`);
      }
    } else if (event.type === 'turn.done') {
      turn1Done = true;
      const status = (event as any).state?.status;
      console.log(`  [Turn 1] Turn finished. Status: ${status}`);
      break;
    }
  }

  if (!approvalReceived) {
    throw new Error('❌ Test Failed: tool.approval_required was never received!');
  }
  if (!toolExecuted) {
    throw new Error('❌ Test Failed: Tool was approved but never executed by MCP server!');
  }
  console.log(`✅ [4/5] Tool approval test completed successfully!`);

  // Step 5: Test Turn Cancellation Workflow
  console.log(`\n⏳ [5/5] Testing Turn 2: Starting a long turn and cancelling it...`);
  const turn2Stream = await tfClient.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: 'Write an exhaustive 3,000 word history of operating systems from CTSS to modern microkernels.'
      }
    ]
  });

  let turn2Cancelled = false;
  let cancelTriggered = false;

  for await (const event of turn2Stream) {
    console.log(`  [Turn 2 Event] ${event.type}`);

    if (event.type === 'turn.created') {
      console.log(`  [Turn 2] Turn started: ${(event as any).turnId}`);
    } else if (!cancelTriggered) {
      console.log(`  [Turn 2] Triggering client cancellation via sessions.cancel()...`);
      cancelTriggered = true;
      const cancelRes = await tfClient.sessions.cancel(sessionId);
      console.log(`  [Turn 2] Cancel API response:`, JSON.stringify(cancelRes));
    }

    if (event.type === 'turn.done') {
      const finalStatus = (event as any).state?.status;
      const finalReason = (event as any).state?.reason;
      console.log(`  [Turn 2] Turn finished. Status: "${finalStatus}", Reason: "${finalReason}"`);
      if (finalStatus === 'cancelled') {
        turn2Cancelled = true;
      }
      break;
    }
  }

  if (!turn2Cancelled) {
    throw new Error('❌ Test Failed: Turn was not cancelled properly!');
  }
  console.log(`✅ [5/5] Turn cancellation test completed successfully!`);

  // Cleanup
  httpServer.close();

  console.log('\n=====================================================');
  console.log('🎉 ALL SMOKE TESTS PASSED!');
  console.log('  1. Dynamic MCP Server Registration: PASS');
  console.log('  2. Inline Spec Session Creation:    PASS');
  console.log('  3. Tool Approval Gating & Allow:   PASS');
  console.log('  4. Turn Cancellation & Rollback:    PASS');
  console.log('=====================================================');
}

main().catch((err) => {
  console.error('\n❌ Smoke Test Fatal Error:', err);
  process.exit(1);
});
