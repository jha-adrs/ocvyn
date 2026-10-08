import * as vscode from 'vscode';
import { GridEditorProvider } from './editorProvider.ts';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(GridEditorProvider.viewType, new GridEditorProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true }, // don't re-index when switching tabs
      supportsMultipleEditorsPerDocument: true,
    }),
    // Editor-title button: swap the current text tab for the grid, like "Reopen Editor With…".
    vscode.commands.registerCommand('ocvyn.openInGrid', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const textTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      await vscode.commands.executeCommand('vscode.openWith', target, GridEditorProvider.viewType);
      if (textTab?.input instanceof vscode.TabInputText && textTab.input.uri.toString() === target.toString()) {
        await vscode.window.tabGroups.close(textTab);
      }
    }),
  );
}

export function deactivate() {}
