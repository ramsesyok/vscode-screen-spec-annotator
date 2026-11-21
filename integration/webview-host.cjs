const { existsSync } = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const vscode = require("vscode");

exports.run = async function () {
  const directory = process.env.SCREEN_SPEC_TEST_DIR;
  const timeout = Date.now() + 90000;
  async function waitFor(name) {
    while (!existsSync(path.join(directory, name))) {
      if (existsSync(path.join(directory, "finished"))) return false;
      if (Date.now() > timeout) throw new Error("Timed out waiting for " + name);
      await delay(50);
    }
    return true;
  }
  if (!await waitFor("connected")) return;
  const uri = vscode.Uri.file(path.join(directory, "workspace", "sample.annotations.json"));
  await vscode.commands.executeCommand("vscode.openWith", uri, "screenSpecAnnotator.annotations");
  if (!await waitFor("reopen")) return;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!(tab?.input instanceof vscode.TabInputCustom) || tab.input.uri.toString() !== uri.toString()) {
    throw new Error("Expected the sample annotation editor to be active");
  }
  if (!await vscode.window.tabGroups.close(tab)) throw new Error("Could not close the sample editor");
  await vscode.commands.executeCommand("vscode.openWith", uri, "screenSpecAnnotator.annotations");
  await waitFor("finished");
};
