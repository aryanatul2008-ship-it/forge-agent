import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const configPath = path.resolve(__dirname, '..', 'agent', 'agent.config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`Agent configuration file not found at ${configPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const client = new TrueForge({
    baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  });

  console.log('Registering agent "forge-agent" with TrueForge...');
  // Ensure MCP server placeholder exists in TrueForge settings
  try {
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: 'vscode-ide',
        type: 'remote',
        description: 'VS Code IDE MCP Server (started dynamically by extension)',
        url: 'http://127.0.0.1:8795/sse',
      },
    });
    console.log('Registered placeholder MCP server "vscode-ide" in TrueForge settings.');
  } catch (mcpErr: any) {
    console.warn('Warning: Could not pre-register vscode-ide MCP server placeholder:', mcpErr?.message || mcpErr);
  }

  try {
    const { data: agent } = await client.agents.create({
      name: 'forge-agent',
      description: 'VS Code coding assistant powered by TrueForge',
      manifest,
    });
    console.log(`Successfully registered agent "forge-agent" with ID: ${agent.id}`);
  } catch (err: any) {
    if (err?.statusCode === 409 || err?.message?.includes('conflict') || err?.message?.includes('already exists')) {
      console.log('Agent "forge-agent" already exists in registry. Updating manifest...');
      // List to get id
      let targetId: string | undefined;
      for await (const existing of await client.agents.list()) {
        if (existing.name === 'forge-agent') {
          targetId = existing.id;
          break;
        }
      }
      if (targetId) {
        await client.agents.update(targetId, {
          description: 'VS Code coding assistant powered by TrueForge',
          manifest,
        });
        console.log(`Successfully updated agent "forge-agent" (ID: ${targetId})`);
      } else {
        console.error('Could not find existing agent ID to update.');
      }
    } else {
      console.error('Failed to register agent:', err);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Unhandled error in register-agent:', err);
  process.exit(1);
});
