import * as vscode from 'vscode';
import { TrueForge } from '@truefoundry/trueforge-sdk';

export function activate(context: vscode.ExtensionContext) {
  console.log('Forge Agent extension activated, TrueForge SDK class:', typeof TrueForge);

  const openChatCommand = vscode.commands.registerCommand('forgeAgent.openChat', () => {
    vscode.window.showInformationMessage('Forge Agent Chat opened');
  });

  const cancelTurnCommand = vscode.commands.registerCommand('forgeAgent.cancelTurn', () => {
    vscode.window.showInformationMessage('Forge Agent Turn cancelled');
  });

  context.subscriptions.push(openChatCommand, cancelTurnCommand);
}

export function deactivate() {
  console.log('Forge Agent extension deactivated');
}
