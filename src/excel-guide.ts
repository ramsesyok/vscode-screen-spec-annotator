import * as vscode from "vscode";
import { messageOf } from "./document-operations";

const title = "Excel連携の手順";

export function registerExcelGuide(context: vscode.ExtensionContext): vscode.Disposable {
  const assets = vscode.Uri.joinPath(context.extensionUri, "dist");
  const styles = vscode.Uri.joinPath(context.extensionUri, "media");
  let panel: vscode.WebviewPanel | undefined;
  return vscode.commands.registerCommand("screenSpecAnnotator.openExcelGuide", async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(assets, "excel-guide.html"));
      if (panel) {
        panel.reveal();
        return;
      }
      const guide = vscode.window.createWebviewPanel("screenSpecAnnotator.excelGuide", title, vscode.ViewColumn.Active, {
        localResourceRoots: [styles],
        enableScripts: true,
      });
      panel = guide;
      guide.onDidDispose(() => { panel = undefined; });
      const css = guide.webview.asWebviewUri(vscode.Uri.joinPath(styles, "excel-guide.css"));
      const script = guide.webview.asWebviewUri(vscode.Uri.joinPath(styles, "excel-guide.js"));
      guide.webview.html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${guide.webview.cspSource}; script-src ${guide.webview.cspSource}; img-src data:">
  <title>${title}</title>
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <header>${title}</header>
  ${new TextDecoder().decode(bytes)}
  <script src="${script}"></script>
</body>
</html>`;
    } catch (error) {
      void vscode.window.showErrorMessage(`Excel連携の手順を開けませんでした。 ${messageOf(error)}`);
    }
  });
}
