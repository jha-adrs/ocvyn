import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from './protocol.ts';

export class GridEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'ocvyn.grid';

  private readonly ctx: vscode.ExtensionContext;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = this.html(panel.webview, dist);

    const post = (m: ToWebview) => void panel.webview.postMessage(m);
    let worker: Worker | undefined;

    const spawn = () => {
      void worker?.terminate();
      if (doc.uri.scheme !== 'file') {
        post({ type: 'error', fatal: true, message: `OCVYN only opens files on disk (got ${doc.uri.scheme}:).` });
        return;
      }
      const w = new Worker(vscode.Uri.joinPath(dist, 'worker.js').fsPath, { workerData: { path: doc.uri.fsPath } });
      worker = w;
      w.on('message', (m: ToWebview) => post(m));
      w.on('error', e => post({ type: 'error', fatal: true, message: `Engine crashed: ${e.message}` }));
      w.on('exit', code => {
        if (worker === w && code !== 0) post({ type: 'error', fatal: true, message: `Engine stopped (exit code ${code}). The file may be too large for available memory.` });
      });
    };

    panel.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready' || m.type === 'reload') spawn();
      else if (m.type === 'copy') void vscode.env.clipboard.writeText(m.text);
      else worker?.postMessage(m);
    });

    panel.onDidDispose(() => {
      const w = worker;
      worker = undefined;
      void w?.terminate();
    });
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
