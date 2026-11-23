const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const project = join(__dirname, "..", "docs", "how-to-excel");
const dist = join(__dirname, "..", "dist");
const { config } = JSON.parse(execFileSync("quarto", ["inspect", project], { encoding: "utf8" }));
const html = execFileSync("quarto", [
  "pandoc", ...config.book.chapters, "--from=markdown", "--to=html5", "--standalone", "--toc", "--toc-depth=2",
  "--number-sections", "--template=webview.html",
], { cwd: project, encoding: "utf8" });

// The webview contains the whole book, so chapter links become same-page anchors.
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "excel-guide.html"), html.replace(/href="[^"/]+\.qmd#/g, 'href="#'));
