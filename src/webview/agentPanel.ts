import * as vscode from 'vscode';
import {
  WebviewMessage,
  ExtensionToWebviewMessage,
  ContextUsedItem,
} from './types';
import { MentionItem } from '../context/types';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgeAgent.chatView';

  private view?: vscode.WebviewView;
  private promptSubmittedCallbacks: Array<(prompt: string) => void> = [];
  private cancelRequestedCallbacks: Array<() => void> = [];
  private approvalCallbacks: Array<(toolCallId: string, decision: 'allow' | 'deny', reason?: string) => void> = [];
  private hunkDecisionCallbacks: Array<(toolCallId: string, hunkId: string, decision: 'accepted' | 'rejected') => void> = [];
  private allHunksDecisionCallbacks: Array<(toolCallId: string, decision: 'accepted' | 'rejected') => void> = [];
  private openDiffCallbacks: Array<(toolCallId: string, filePath: string) => void> = [];
  private openFileCallbacks: Array<(filePath: string, line?: number) => void> = [];
  private queryMentionsCallbacks: Array<(query: string) => void> = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
          this.postMessage({ type: 'status', status: 'ready', details: 'Agent is ready' });
          break;

        case 'sendPrompt':
          for (const cb of this.promptSubmittedCallbacks) {
            cb(message.text);
          }
          break;

        case 'cancelTurn':
          for (const cb of this.cancelRequestedCallbacks) {
            cb();
          }
          break;

        case 'approveTool':
          for (const cb of this.approvalCallbacks) {
            cb(message.toolCallId, message.decision, message.reason);
          }
          break;

        case 'hunkDecision':
          for (const cb of this.hunkDecisionCallbacks) {
            cb(message.toolCallId, message.hunkId, message.decision);
          }
          break;

        case 'allHunksDecision':
          for (const cb of this.allHunksDecisionCallbacks) {
            cb(message.toolCallId, message.decision);
          }
          break;

        case 'openDiff':
          for (const cb of this.openDiffCallbacks) {
            cb(message.toolCallId, message.filePath);
          }
          break;

        case 'openFile':
          for (const cb of this.openFileCallbacks) {
            cb(message.filePath, message.line);
          }
          break;

        case 'queryMentions':
          for (const cb of this.queryMentionsCallbacks) {
            cb(message.query);
          }
          break;
      }
    });
  }

  public postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(message);
  }

  public show(): void {
    this.view?.show?.(true);
  }

  public onPromptSubmitted(cb: (prompt: string) => void): { dispose: () => void } {
    this.promptSubmittedCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.promptSubmittedCallbacks.indexOf(cb);
        if (idx !== -1) this.promptSubmittedCallbacks.splice(idx, 1);
      },
    };
  }

  public onCancelRequested(cb: () => void): { dispose: () => void } {
    this.cancelRequestedCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.cancelRequestedCallbacks.indexOf(cb);
        if (idx !== -1) this.cancelRequestedCallbacks.splice(idx, 1);
      },
    };
  }

  public onApprovalDecision(
    cb: (toolCallId: string, decision: 'allow' | 'deny', reason?: string) => void
  ): { dispose: () => void } {
    this.approvalCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.approvalCallbacks.indexOf(cb);
        if (idx !== -1) this.approvalCallbacks.splice(idx, 1);
      },
    };
  }

  public onHunkDecision(
    cb: (toolCallId: string, hunkId: string, decision: 'accepted' | 'rejected') => void
  ): { dispose: () => void } {
    this.hunkDecisionCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.hunkDecisionCallbacks.indexOf(cb);
        if (idx !== -1) this.hunkDecisionCallbacks.splice(idx, 1);
      },
    };
  }

  public onAllHunksDecision(
    cb: (toolCallId: string, decision: 'accepted' | 'rejected') => void
  ): { dispose: () => void } {
    this.allHunksDecisionCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.allHunksDecisionCallbacks.indexOf(cb);
        if (idx !== -1) this.allHunksDecisionCallbacks.splice(idx, 1);
      },
    };
  }

  public onOpenDiff(cb: (toolCallId: string, filePath: string) => void): { dispose: () => void } {
    this.openDiffCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.openDiffCallbacks.indexOf(cb);
        if (idx !== -1) this.openDiffCallbacks.splice(idx, 1);
      },
    };
  }

  public onOpenFile(cb: (filePath: string, line?: number) => void): { dispose: () => void } {
    this.openFileCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.openFileCallbacks.indexOf(cb);
        if (idx !== -1) this.openFileCallbacks.splice(idx, 1);
      },
    };
  }

  public onQueryMentions(cb: (query: string) => void): { dispose: () => void } {
    this.queryMentionsCallbacks.push(cb);
    return {
      dispose: () => {
        const idx = this.queryMentionsCallbacks.indexOf(cb);
        if (idx !== -1) this.queryMentionsCallbacks.splice(idx, 1);
      },
    };
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge Agent</title>
  <style>
    *, *:before, *:after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Header & Status Bar */
    .status-bar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: var(--vscode-editor-background, #1e1e1e);
      flex-shrink: 0;
    }
    .status-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-badge.ready { background: #28a745; color: #fff; }
    .status-badge.running { background: #007acc; color: #fff; }
    .status-badge.streaming { background: #17a2b8; color: #fff; }
    .status-badge.calling_tool { background: #6f42c1; color: #fff; }
    .status-badge.paused { background: #fd7e14; color: #fff; }
    .status-badge.cancelled { background: #6c757d; color: #fff; }
    .status-badge.done { background: #28a745; color: #fff; }
    .status-badge.error { background: #dc3545; color: #fff; }

    .status-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 130px;
    }

    /* TrueForge Context Feature Pill */
    .context-feature-pill {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      background: rgba(111, 66, 193, 0.25);
      border: 1px solid rgba(111, 66, 193, 0.5);
      color: #b392f0;
      font-weight: 600;
      cursor: default;
    }

    /* Messages Stream */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty-state {
      margin: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
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
      max-width: 98%;
      width: 100%;
      white-space: pre-wrap;
    }

    /* "Context Used" Card */
    .context-card {
      background-color: rgba(0, 122, 204, 0.08);
      border: 1px solid rgba(0, 122, 204, 0.3);
      border-left: 4px solid #007acc;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .context-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      color: var(--vscode-editorInfo-foreground, #3794ff);
      cursor: pointer;
      user-select: none;
    }
    .context-header:hover {
      opacity: 0.9;
    }
    .context-header .toggle-icon {
      font-size: 10px;
      transition: transform 0.2s ease;
    }
    .context-header .toggle-icon.collapsed {
      transform: rotate(-90deg);
    }
    .budget-bar-wrapper {
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin: 2px 0;
    }
    .budget-bar-fill {
      height: 100%;
      background: #007acc;
      border-radius: 2px;
    }
    .context-items-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
    }
    .context-item {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 3px;
      padding: 6px 8px;
      font-size: 11px;
    }
    .context-item-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 3px;
    }
    .context-file-link {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
      font-weight: 600;
      cursor: pointer;
    }
    .context-file-link:hover {
      text-decoration: underline;
    }
    .context-reason-pill {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.1);
      color: var(--vscode-descriptionForeground, #aaa);
    }
    .context-tokens-badge {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .context-snippet-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      background: rgba(0, 0, 0, 0.3);
      padding: 4px 6px;
      border-radius: 2px;
      margin: 2px 0 0 0;
      max-height: 80px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: #ddd;
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
      justify-content: space-between;
      gap: 6px;
      font-weight: 600;
      color: var(--vscode-editorInfo-foreground, #3794ff);
      margin-bottom: 4px;
    }
    .tf-deferred-badge {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 8px;
      background: rgba(111, 66, 193, 0.3);
      border: 1px solid rgba(111, 66, 193, 0.6);
      color: #b392f0;
      font-weight: normal;
      font-family: var(--vscode-font-family, sans-serif);
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

    /* Review Card & Hunk Reviewer */
    .review-card {
      background-color: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #e2c08d);
      border-left: 4px solid #fd7e14;
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
    }
    .review-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 6px;
    }
    .review-title {
      font-weight: 700;
      font-size: 13px;
      color: #fd7e14;
    }
    .review-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #aaa);
      margin-top: 2px;
    }
    .review-actions-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .btn-review {
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 3px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    .btn-accept-all { background-color: #28a745; color: #fff; }
    .btn-reject-all { background-color: #6c757d; color: #fff; }
    .btn-diff-view {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn-approve-submit {
      background-color: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      font-weight: bold;
      padding: 4px 10px;
    }
    .btn-deny-submit {
      background-color: #dc3545;
      color: #fff;
      padding: 4px 10px;
    }

    /* Hunk Cards */
    .hunk-card {
      background-color: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      overflow: hidden;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .hunk-card.status-accepted { border-left: 3px solid #28a745; }
    .hunk-card.status-rejected { border-left: 3px solid #dc3545; opacity: 0.65; }
    .hunk-card.status-pending { border-left: 3px solid #fd7e14; }
    .hunk-header {
      padding: 4px 8px;
      background-color: rgba(255, 255, 255, 0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hunk-info {
      color: var(--vscode-descriptionForeground, #888);
      font-size: 11px;
    }
    .hunk-buttons {
      display: flex;
      gap: 4px;
    }
    .btn-hunk {
      padding: 2px 6px;
      font-size: 10px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: transparent;
      color: var(--vscode-foreground);
    }
    .btn-hunk.accept.active { background: #28a745; color: #fff; border-color: #28a745; }
    .btn-hunk.reject.active { background: #dc3545; color: #fff; border-color: #dc3545; }
    .hunk-diff-body {
      padding: 6px;
      max-height: 160px;
      overflow: auto;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .diff-del {
      background-color: rgba(220, 53, 69, 0.2);
      color: #f85149;
      display: block;
    }
    .diff-add {
      background-color: rgba(40, 167, 69, 0.2);
      color: #56d364;
      display: block;
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

    /* Input & Autocomplete Area */
    .input-section {
      padding: 10px 14px;
      border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      position: relative;
    }
    .textarea-wrapper {
      position: relative;
      display: flex;
    }
    #promptInput {
      width: 100%;
      min-height: 60px;
      max-height: 180px;
      resize: vertical;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 13px;
      background-color: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      outline: none;
    }
    #promptInput:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }

    /* Floating Autocomplete Dropdown */
    .mention-dropdown {
      position: absolute;
      bottom: 100%;
      left: 14px;
      right: 14px;
      margin-bottom: 6px;
      max-height: 220px;
      overflow-y: auto;
      background-color: var(--vscode-dropdown-background, #252526);
      border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      z-index: 1000;
      display: none;
    }
    .mention-dropdown.visible {
      display: block;
    }
    .mention-item {
      padding: 6px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .mention-item:hover, .mention-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground, #007acc);
      color: var(--vscode-list-activeSelectionForeground, #fff);
    }
    .mention-item-label {
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mention-item-detail {
      font-size: 10.5px;
      opacity: 0.75;
      white-space: nowrap;
    }

    .actions-bar {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    button.btn-primary {
      background-color: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 6px 14px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    button.btn-primary:hover {
      background-color: var(--vscode-button-hoverBackground, #0062a3);
    }
    button.btn-cancel {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.2));
      padding: 6px 12px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      display: none;
    }
    button.btn-cancel.active {
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="status-bar">
    <div class="status-left">
      <span class="status-badge ready" id="statusBadge">Ready</span>
      <span class="status-details" id="statusDetails">Agent is ready</span>
      <span class="context-feature-pill" title="TrueForge Deferred Tool Loading (preload: false) and Compaction are active">⚡ Deferred Tools Active</span>
    </div>
  </div>

  <div class="messages-container" id="messagesContainer">
    <div class="empty-state" id="emptyState">
      <div class="ready-pill">ready</div>
      <div>Ask Forge Agent to inspect, search, or edit your code.</div>
      <div style="font-size: 11px; margin-top: 4px;">Type <code>@</code> for file and symbol mentions</div>
    </div>
  </div>

  <div class="input-section">
    <!-- Autocomplete Dropdown -->
    <div class="mention-dropdown" id="mentionDropdown"></div>

    <div class="textarea-wrapper">
      <textarea id="promptInput" placeholder="Ask a question or request a change... (type @ for files & symbols)"></textarea>
    </div>
    <div class="actions-bar">
      <button class="btn-cancel" id="btnCancel">Cancel</button>
      <button class="btn-primary" id="btnSend">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const statusBadge = document.getElementById('statusBadge');
    const statusDetails = document.getElementById('statusDetails');
    const messagesContainer = document.getElementById('messagesContainer');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const btnSend = document.getElementById('btnSend');
    const btnCancel = document.getElementById('btnCancel');
    const mentionDropdown = document.getElementById('mentionDropdown');

    let currentAssistantEl = null;
    let isTurnActive = false;
    const activeReviews = new Map(); // toolCallId -> { cardEl, edit }

    // Mention Autocomplete State
    let mentionQueryState = null; // { startIdx, query }
    let mentionSuggestions = [];
    let selectedMentionIndex = -1;

    function setTurnState(active) {
      isTurnActive = active;
      if (active) {
        btnCancel.classList.add('active');
        btnSend.disabled = true;
      } else {
        btnCancel.classList.remove('active');
        btnSend.disabled = false;
      }
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

    function appendContextUsed(data) {
      removeEmptyState();
      const card = document.createElement('div');
      card.className = 'context-card';

      const pct = Math.min(100, Math.round((data.totalTokens / data.budgetTokens) * 100));

      const header = document.createElement('div');
      header.className = 'context-header';
      header.innerHTML = \`
        <span>📦 Context Used (\${data.totalTokens.toLocaleString()} / \${data.budgetTokens.toLocaleString()} tokens • \${data.items.length} snippets)</span>
        <span class="toggle-icon">▾</span>
      \`;
      card.appendChild(header);

      const barWrap = document.createElement('div');
      barWrap.className = 'budget-bar-wrapper';
      barWrap.innerHTML = \`<div class="budget-bar-fill" style="width: \${pct}%"></div>\`;
      card.appendChild(barWrap);

      const itemsList = document.createElement('div');
      itemsList.className = 'context-items-list';

      for (const item of data.items) {
        const itemEl = document.createElement('div');
        itemEl.className = 'context-item';

        const top = document.createElement('div');
        top.className = 'context-item-top';

        const link = document.createElement('a');
        link.className = 'context-file-link';
        link.textContent = '📁 ' + item.file + (item.range ? ' (' + item.range + ')' : '');
        link.onclick = (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openFile', filePath: item.file, line: item.line });
        };
        top.appendChild(link);

        const badge = document.createElement('span');
        badge.className = 'context-tokens-badge';
        badge.textContent = '~' + item.tokens + ' tokens';
        top.appendChild(badge);

        itemEl.appendChild(top);

        const reasonEl = document.createElement('div');
        reasonEl.innerHTML = \`<span class="context-reason-pill">Why: \${escapeHtml(item.reason)}</span>\`;
        itemEl.appendChild(reasonEl);

        if (item.snippetPreview) {
          const pre = document.createElement('pre');
          pre.className = 'context-snippet-code';
          pre.textContent = item.snippetPreview;
          itemEl.appendChild(pre);
        }

        itemsList.appendChild(itemEl);
      }

      card.appendChild(itemsList);

      // Collapsible toggle
      header.onclick = () => {
        const isHidden = itemsList.style.display === 'none';
        itemsList.style.display = isHidden ? 'flex' : 'none';
        header.querySelector('.toggle-icon').classList.toggle('collapsed', !isHidden);
      };

      messagesContainer.appendChild(card);
      scrollToBottom();
    }

    function appendToolCall(tool) {
      removeEmptyState();
      const card = document.createElement('div');
      card.className = 'tool-card';
      
      const header = document.createElement('div');
      header.className = 'tool-header';
      
      const isDeferredMeta = tool.name === 'list_tools' || tool.name === 'get_tool_info' || tool.name === 'call_tool';
      const badgeHtml = isDeferredMeta
        ? '<span class="tf-deferred-badge">⚡ TrueForge Deferred Tool</span>'
        : '';

      header.innerHTML = \`<span>🔧 \${escapeHtml(tool.name)}</span>\${badgeHtml}\`;
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

    function renderReviewCard(toolCallId, edit, isCommand = false, commandStr = '') {
      removeEmptyState();
      let card = activeReviews.get(toolCallId)?.cardEl;
      if (!card) {
        card = document.createElement('div');
        card.className = 'review-card';
        messagesContainer.appendChild(card);
      }
      card.innerHTML = '';

      if (isCommand) {
        const header = document.createElement('div');
        header.className = 'review-header';
        header.innerHTML = '<div class="review-title">Approval Required: Run Command</div>';
        card.appendChild(header);

        const desc = document.createElement('div');
        desc.className = 'review-desc';
        desc.textContent = 'The agent wants to execute the following command:';
        card.appendChild(desc);

        const cmdPre = document.createElement('pre');
        cmdPre.className = 'tool-body';
        cmdPre.textContent = commandStr;
        card.appendChild(cmdPre);

        const actions = document.createElement('div');
        actions.className = 'review-actions-bar';
        actions.innerHTML = \`
          <button class="btn-review btn-approve-submit" id="btn-allow-\${toolCallId}">Allow Command</button>
          <button class="btn-review btn-deny-submit" id="btn-deny-\${toolCallId}">Deny Command</button>
        \`;
        card.appendChild(actions);

        actions.querySelector('#btn-allow-' + toolCallId).onclick = () => {
          vscode.postMessage({ type: 'approveTool', toolCallId, decision: 'allow' });
          card.style.opacity = '0.5';
        };
        actions.querySelector('#btn-deny-' + toolCallId).onclick = () => {
          vscode.postMessage({ type: 'approveTool', toolCallId, decision: 'deny', reason: 'User denied command' });
          card.style.opacity = '0.5';
        };
        scrollToBottom();
        return;
      }

      // Propose Edit Review UI
      const header = document.createElement('div');
      header.className = 'review-header';
      header.innerHTML = \`
        <div>
          <div class="review-title">Proposed Edit: \${escapeHtml(edit.filePath)}</div>
          <div class="review-desc">\${escapeHtml(edit.description || 'Review proposed changes per hunk')}</div>
        </div>
      \`;
      card.appendChild(header);

      // Top Actions Bar
      const actionsBar = document.createElement('div');
      actionsBar.className = 'review-actions-bar';
      actionsBar.innerHTML = \`
        <button class="btn-review btn-accept-all" id="btn-acc-all-\${toolCallId}">Accept All</button>
        <button class="btn-review btn-reject-all" id="btn-rej-all-\${toolCallId}">Reject All</button>
        <button class="btn-review btn-diff-view" id="btn-diff-\${toolCallId}">Open Diff View</button>
        <button class="btn-review btn-approve-submit" id="btn-apply-\${toolCallId}">Apply & Approve</button>
        <button class="btn-review btn-deny-submit" id="btn-deny-\${toolCallId}">Deny</button>
      \`;
      card.appendChild(actionsBar);

      actionsBar.querySelector('#btn-acc-all-' + toolCallId).onclick = () => {
        vscode.postMessage({ type: 'allHunksDecision', toolCallId, decision: 'accepted' });
      };
      actionsBar.querySelector('#btn-rej-all-' + toolCallId).onclick = () => {
        vscode.postMessage({ type: 'allHunksDecision', toolCallId, decision: 'rejected' });
      };
      actionsBar.querySelector('#btn-diff-' + toolCallId).onclick = () => {
        vscode.postMessage({ type: 'openDiff', toolCallId, filePath: edit.filePath });
      };
      actionsBar.querySelector('#btn-apply-' + toolCallId).onclick = () => {
        vscode.postMessage({ type: 'approveTool', toolCallId, decision: 'allow' });
        card.style.opacity = '0.6';
      };
      actionsBar.querySelector('#btn-deny-' + toolCallId).onclick = () => {
        vscode.postMessage({ type: 'approveTool', toolCallId, decision: 'deny', reason: 'User rejected all proposed edits' });
        card.style.opacity = '0.6';
      };

      // Per-Hunk Rendering
      if (edit.hunks && edit.hunks.length > 0) {
        for (const hunk of edit.hunks) {
          const hunkEl = document.createElement('div');
          hunkEl.className = 'hunk-card status-' + hunk.status;

          const hHead = document.createElement('div');
          hHead.className = 'hunk-header';
          hHead.innerHTML = \`
            <span class="hunk-info">\${escapeHtml(hunk.id)} (Line \${hunk.oldStart} \${hunk.status.toUpperCase()})</span>
            <div class="hunk-buttons">
              <button class="btn-hunk accept \${hunk.status === 'accepted' ? 'active' : ''}" id="btn-h-acc-\${hunk.id}">Accept</button>
              <button class="btn-hunk reject \${hunk.status === 'rejected' ? 'active' : ''}" id="btn-h-rej-\${hunk.id}">Reject</button>
            </div>
          \`;
          hunkEl.appendChild(hHead);

          const hBody = document.createElement('div');
          hBody.className = 'hunk-diff-body';

          const oldLines = hunk.oldText ? hunk.oldText.split('\\n') : [];
          const newLines = hunk.newText ? hunk.newText.split('\\n') : [];

          for (const l of oldLines) {
            const span = document.createElement('span');
            span.className = 'diff-del';
            span.textContent = '- ' + l;
            hBody.appendChild(span);
          }
          for (const l of newLines) {
            const span = document.createElement('span');
            span.className = 'diff-add';
            span.textContent = '+ ' + l;
            hBody.appendChild(span);
          }
          hunkEl.appendChild(hBody);

          hHead.querySelector('#btn-h-acc-' + hunk.id).onclick = () => {
            vscode.postMessage({ type: 'hunkDecision', toolCallId, hunkId: hunk.id, decision: 'accepted' });
          };
          hHead.querySelector('#btn-h-rej-' + hunk.id).onclick = () => {
            vscode.postMessage({ type: 'hunkDecision', toolCallId, hunkId: hunk.id, decision: 'rejected' });
          };

          card.appendChild(hunkEl);
        }
      }

      activeReviews.set(toolCallId, { cardEl: card, edit });
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

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // --- Mention Autocomplete Logic ---
    function checkMentionInput() {
      const text = promptInput.value;
      const cursorPos = promptInput.selectionStart;
      const textBeforeCursor = text.slice(0, cursorPos);

      // Match last @mention in progress before cursor
      const lastAtIdx = textBeforeCursor.lastIndexOf('@');
      if (lastAtIdx === -1) {
        hideMentionDropdown();
        return;
      }

      const queryPart = textBeforeCursor.slice(lastAtIdx + 1);
      // If there is whitespace after @ (and not @file / @symbol), ignore
      if (/\\s/.test(queryPart)) {
        hideMentionDropdown();
        return;
      }

      mentionQueryState = {
        startIdx: lastAtIdx,
        query: queryPart,
      };

      vscode.postMessage({ type: 'queryMentions', query: queryPart });
    }

    function renderMentionSuggestions(suggestions) {
      mentionSuggestions = suggestions;
      selectedMentionIndex = suggestions.length > 0 ? 0 : -1;

      if (!mentionQueryState || suggestions.length === 0) {
        hideMentionDropdown();
        return;
      }

      mentionDropdown.innerHTML = '';
      for (let i = 0; i < suggestions.length; i++) {
        const item = suggestions[i];
        const el = document.createElement('div');
        el.className = 'mention-item' + (i === 0 ? ' selected' : '');

        const icon = item.type === 'file' ? '📁' : '⚡';
        el.innerHTML = \`
          <span class="mention-item-label">\${icon} \${escapeHtml(item.label)}</span>
          <span class="mention-item-detail">\${escapeHtml(item.detail)}</span>
        \`;

        el.onmousedown = (e) => {
          e.preventDefault(); // prevent blur
          selectMentionItem(item);
        };

        mentionDropdown.appendChild(el);
      }

      mentionDropdown.classList.add('visible');
    }

    function hideMentionDropdown() {
      mentionDropdown.classList.remove('visible');
      mentionDropdown.innerHTML = '';
      mentionQueryState = null;
      mentionSuggestions = [];
      selectedMentionIndex = -1;
    }

    function selectMentionItem(item) {
      if (!mentionQueryState) return;

      const text = promptInput.value;
      const start = mentionQueryState.startIdx;
      const cursorPos = promptInput.selectionStart;

      const before = text.slice(0, start);
      const after = text.slice(cursorPos);
      const insertText = item.value + ' ';

      promptInput.value = before + insertText + after;
      const newCursor = start + insertText.length;
      promptInput.setSelectionRange(newCursor, newCursor);

      hideMentionDropdown();
      promptInput.focus();
    }

    function handleSend() {
      const text = promptInput.value.trim();
      if (!text || isTurnActive) return;

      hideMentionDropdown();
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

    promptInput.addEventListener('input', checkMentionInput);

    promptInput.addEventListener('keydown', (e) => {
      if (mentionDropdown.classList.contains('visible') && mentionSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedMentionIndex = (selectedMentionIndex + 1) % mentionSuggestions.length;
          updateSelectedMentionUI();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedMentionIndex = (selectedMentionIndex - 1 + mentionSuggestions.length) % mentionSuggestions.length;
          updateSelectedMentionUI();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (selectedMentionIndex >= 0 && selectedMentionIndex < mentionSuggestions.length) {
            selectMentionItem(mentionSuggestions[selectedMentionIndex]);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideMentionDropdown();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    function updateSelectedMentionUI() {
      const items = mentionDropdown.querySelectorAll('.mention-item');
      items.forEach((item, idx) => {
        item.classList.toggle('selected', idx === selectedMentionIndex);
        if (idx === selectedMentionIndex) {
          item.scrollIntoView({ block: 'nearest' });
        }
      });
    }

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
        case 'contextUsed':
          appendContextUsed(msg);
          break;
        case 'mentionSuggestions':
          renderMentionSuggestions(msg.suggestions);
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
        case 'toolApprovalRequired':
          if (msg.name === 'propose_edit' && msg.edit) {
            renderReviewCard(msg.toolCallId, msg.edit);
          } else if (msg.name === 'run_command') {
            const cmd = msg.arguments?.command || JSON.stringify(msg.arguments);
            renderReviewCard(msg.toolCallId, null, true, cmd);
          } else {
            renderReviewCard(msg.toolCallId, null, true, JSON.stringify(msg.arguments));
          }
          break;
        case 'stagedEdit':
          if (msg.edit) {
            renderReviewCard(msg.edit.toolCallId, msg.edit);
          }
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
