import * as vscode from 'vscode';
import { WebviewMessage, ExtensionToWebviewMessage } from './types';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgeAgent.chatView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          console.log('[AgentPanel] Webview reported ready');
          break;
        case 'sendPrompt':
          vscode.commands.executeCommand('forgeAgent.submitPrompt', message.text);
          break;
        case 'cancelTurn':
          vscode.commands.executeCommand('forgeAgent.cancelTurn');
          break;
      }
    });
  }

  public postMessage(message: ExtensionToWebviewMessage) {
    this._view?.webview.postMessage(message);
  }

  public show() {
    if (this._view) {
      this._view.show?.(true);
    } else {
      vscode.commands.executeCommand('forgeAgent.chatView.focus');
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Forge Agent</title>
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background, transparent);
      padding: 16px;
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      text-align: center;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      background-color: var(--vscode-badge-background, rgba(255, 255, 255, 0.1));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      font-weight: 500;
      font-size: 13px;
      letter-spacing: 0.5px;
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    .subtitle {
      margin-top: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-badge" id="status">ready</div>
    <div class="subtitle">TF Agent Panel</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'status') {
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = message.text;
        }
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
