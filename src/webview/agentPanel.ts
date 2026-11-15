import * as vscode from 'vscode';
import { WebviewMessage, ExtensionToWebviewMessage } from './types';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgeAgent.chatView';
  private _view?: vscode.WebviewView;

  private _onPromptSubmitted = new vscode.EventEmitter<string>();
  public readonly onPromptSubmitted = this._onPromptSubmitted.event;

  private _onCancelRequested = new vscode.EventEmitter<void>();
  public readonly onCancelRequested = this._onCancelRequested.event;

  private _onApprovalDecision = new vscode.EventEmitter<{
    toolCallId: string;
    decision: 'allow' | 'deny';
    reason?: string;
  }>();
  public readonly onApprovalDecision = this._onApprovalDecision.event;

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
          console.log('[AgentPanel] Webview ready');
          break;
        case 'sendPrompt':
          this._onPromptSubmitted.fire(message.text);
          break;
        case 'cancelTurn':
          this._onCancelRequested.fire();
          break;
        case 'approveTool':
          this._onApprovalDecision.fire({
            toolCallId: message.toolCallId,
            decision: message.decision,
            reason: message.reason,
          });
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Header & Status */
    .header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: var(--vscode-sideBarSectionHeader-background, rgba(0, 0, 0, 0.15));
      flex-shrink: 0;
    }
    .status-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-badge {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background, #3794ff);
      color: var(--vscode-badge-foreground, #ffffff);
    }
    .status-badge.ready { background: #28a745; color: #fff; }
    .status-badge.running { background: #007acc; color: #fff; }
    .status-badge.paused { background: #e2a03f; color: #fff; }
    .status-badge.cancelled { background: #6c757d; color: #fff; }
    .status-badge.error { background: #d73a49; color: #fff; }

    .status-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 180px;
    }

    /* Messages Stream Container */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground, #888);
      gap: 6px;
      text-align: center;
    }
    .empty-state .ready-pill {
      font-size: 13px;
      font-weight: bold;
      color: var(--vscode-foreground);
      padding: 4px 12px;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 14px;
    }

    /* Message Bubbles */
    .message {
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.45;
      word-break: break-word;
      font-size: 13px;
    }
    .message.user {
      align-self: flex-end;
      background-color: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      max-width: 85%;
    }
    .message.assistant {
      align-self: flex-start;
      background-color: var(--vscode-editor-inactiveSelectionBackground, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
      max-width: 95%;
      width: 100%;
      white-space: pre-wrap;
    }

    /* Tool Call Cards */
    .tool-card {
      background-color: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, #333);
      border-left: 3px solid #007acc;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      color: var(--vscode-editorInfo-foreground, #3794ff);
      margin-bottom: 4px;
    }
    .tool-body {
      background-color: rgba(0, 0, 0, 0.2);
      padding: 6px 8px;
      border-radius: 3px;
      font-size: 11px;
      overflow-x: auto;
      max-height: 150px;
      white-space: pre-wrap;
      color: var(--vscode-foreground);
    }

    /* Tool Result Cards */
    .tool-result-card {
      background-color: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, #333);
      border-left: 3px solid #28a745;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-result-title {
      font-weight: 600;
      color: #28a745;
      margin-bottom: 4px;
    }

    /* Error Banner */
    .error-banner {
      background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-foreground, #fff);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
    }

    /* Input & Actions Area */
    .input-section {
      padding: 10px 14px;
      border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .input-box {
      width: 100%;
      height: 70px;
      padding: 8px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background-color: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #ccc);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
    }
    .input-box:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .button-row {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    button {
      padding: 6px 14px;
      font-size: 12px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      border: none;
    }
    .btn-send {
      background-color: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      font-weight: 500;
    }
    .btn-send:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-cancel {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn-cancel:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .btn-cancel:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="status-container">
      <div class="status-badge ready" id="status-badge">ready</div>
      <div class="status-details" id="status-details">Agent ready</div>
    </div>
  </div>

  <div class="messages-container" id="messages-container">
    <div class="empty-state" id="empty-state">
      <div class="ready-pill">ready</div>
      <p>Ask a question or issue a coding instruction.</p>
    </div>
  </div>

  <div class="input-section">
    <textarea
      id="prompt-input"
      class="input-box"
      placeholder="Type message... (Enter to send, Shift+Enter for newline)"
    ></textarea>
    <div class="button-row">
      <button class="btn-cancel" id="btn-cancel" disabled>Cancel</button>
      <button class="btn-send" id="btn-send">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const statusBadge = document.getElementById('status-badge');
    const statusDetails = document.getElementById('status-details');
    const messagesContainer = document.getElementById('messages-container');
    const emptyState = document.getElementById('empty-state');
    const promptInput = document.getElementById('prompt-input');
    const btnSend = document.getElementById('btn-send');
    const btnCancel = document.getElementById('btn-cancel');

    let isTurnActive = false;
    let currentAssistantEl = null;

    function setTurnState(active) {
      isTurnActive = active;
      btnCancel.disabled = !active;
      btnSend.disabled = active;
      promptInput.disabled = active;
      if (!active) {
        promptInput.focus();
      }
    }

    function removeEmptyState() {
      if (emptyState && emptyState.parentNode) {
        emptyState.parentNode.removeChild(emptyState);
      }
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function appendUserMessage(text) {
      removeEmptyState();
      const div = document.createElement('div');
      div.className = 'message user';
      div.textContent = text;
      messagesContainer.appendChild(div);
      scrollToBottom();
    }

    function startAssistantMessage() {
      removeEmptyState();
      const div = document.createElement('div');
      div.className = 'message assistant';
      messagesContainer.appendChild(div);
      currentAssistantEl = div;
      scrollToBottom();
    }

    function appendToken(content) {
      if (!currentAssistantEl) {
        startAssistantMessage();
      }
      currentAssistantEl.textContent += content;
      scrollToBottom();
    }

    function appendToolCall(tool) {
      removeEmptyState();
      const card = document.createElement('div');
      card.className = 'tool-card';
      
      const header = document.createElement('div');
      header.className = 'tool-header';
      header.textContent = '🔧 ' + tool.name;
      card.appendChild(header);

      if (tool.arguments) {
        const body = document.createElement('pre');
        body.className = 'tool-body';
        body.textContent = typeof tool.arguments === 'string'
          ? tool.arguments
          : JSON.stringify(tool.arguments, null, 2);
        card.appendChild(body);
      }

      messagesContainer.appendChild(card);
      // Reset currentAssistantEl so subsequent tokens start in a new block
      currentAssistantEl = null;
      scrollToBottom();
    }

    function appendToolResponse(resp) {
      removeEmptyState();
      const card = document.createElement('div');
      card.className = 'tool-result-card';

      const title = document.createElement('div');
      title.className = 'tool-result-title';
      title.textContent = '⚡ Tool Result';
      card.appendChild(title);

      const body = document.createElement('pre');
      body.className = 'tool-body';
      body.textContent = resp.content;
      card.appendChild(body);

      messagesContainer.appendChild(card);
      currentAssistantEl = null;
      scrollToBottom();
    }

    function appendError(msg) {
      removeEmptyState();
      const banner = document.createElement('div');
      banner.className = 'error-banner';
      banner.textContent = '⚠️ ' + msg;
      messagesContainer.appendChild(banner);
      scrollToBottom();
    }

    function updateStatus(status, details) {
      statusBadge.textContent = status;
      statusBadge.className = 'status-badge ' + status;
      if (details) {
        statusDetails.textContent = details;
      }
    }

    function handleSend() {
      const text = promptInput.value.trim();
      if (!text || isTurnActive) return;

      appendUserMessage(text);
      promptInput.value = '';
      setTurnState(true);
      updateStatus('running', 'Initiating turn...');

      vscode.postMessage({ type: 'sendPrompt', text });
    }

    btnSend.addEventListener('click', handleSend);
    btnCancel.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelTurn' });
      updateStatus('cancelling', 'Cancelling turn...');
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          updateStatus(msg.status, msg.details);
          break;
        case 'userMessage':
          appendUserMessage(msg.text);
          break;
        case 'assistantStart':
          startAssistantMessage();
          break;
        case 'token':
          appendToken(msg.content);
          break;
        case 'toolCall':
          appendToolCall(msg);
          break;
        case 'toolResponse':
          appendToolResponse(msg);
          break;
        case 'turnDone':
          setTurnState(false);
          updateStatus(msg.status, msg.reason ? ('Reason: ' + msg.reason) : 'Turn complete');
          currentAssistantEl = null;
          break;
        case 'error':
          setTurnState(false);
          appendError(msg.message);
          updateStatus('error', msg.message);
          break;
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
