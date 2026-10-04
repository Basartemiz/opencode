#!/usr/bin/env python3
"""Builds the two survey pages from one real understand-mode session.

A.html: what OpenCode shows today at the end of a run: the agent's final summary and the
        cumulative diff per file (like the review panel).
B.html: the understand map page itself (packages/opencode/src/checkpoint/map.html.txt),
        with the session's /data response embedded so it works as a static file.

Both pages show the same task text (without the hidden instruction) at the top.

Usage: python3 study/survey/build_pages.py
Inputs:  study/session/{task.md, map-data.json, final.diff, summary.md}
Outputs: study/survey/A.html, study/survey/B.html
"""

import html
import json
import re
import sys
from pathlib import Path

STUDY = Path(__file__).resolve().parent.parent
REPO = STUDY.parent
MAP_PAGE = REPO / "packages/opencode/src/checkpoint/map.html.txt"
import os
SESSION = Path(os.environ.get("STUDY_SESSION", STUDY / "session"))
OUT = Path(os.environ.get("STUDY_OUT", STUDY / "survey"))
MAP_PAGE = Path(os.environ.get("MAP_PAGE", MAP_PAGE))

BANNER_CSS = """
.study-task { background: var(--sheet); border-bottom: 1px solid var(--rule); padding: 14px 20px; }
.study-task h2 { margin: 0 0 6px; font-size: 0.74rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.study-task .prompt { margin: 0; white-space: pre-wrap; font: 0.92rem/1.5 var(--sans); max-width: 900px; }
.study-task .hint { margin: 8px 0 0; color: var(--muted); font-size: 0.85rem; }
"""


def banner(task: str) -> str:
    return (
        '<section class="study-task">'
        "<h2>The task the user gave the coding agent</h2>"
        f'<p class="prompt">{html.escape(task)}</p>'
        '<p class="hint">Look around this page as you like, then answer the questions in the form.</p>'
        "</section>"
    )


# ---------- B: the real map page, made static ----------


def build_b(task: str) -> str:
    page = MAP_PAGE.read_text()
    data = json.loads((SESSION / "map-data.json").read_text())
    embedded = json.dumps(data).replace("</", "<\\/")
    shim = (
        "<script>\n"
        "// Static copy for the survey: the page's /data request is answered from this embedded session.\n"
        f"window.__STUDY_DATA__ = {embedded};\n"
        "(() => {\n"
        "  const original = window.fetch.bind(window)\n"
        "  window.fetch = (url, options) => String(url).endsWith('/data')\n"
        "    ? Promise.resolve(new Response(JSON.stringify(window.__STUDY_DATA__), { status: 200, headers: { 'content-type': 'application/json' } }))\n"
        "    : original(url, options)\n"
        "})()\n"
        "</script>\n"
    )
    hide = "\n/* survey copy: no live server, no downloads */\n.live, #download, a.button[download] { display: none !important; }\n"
    page = page.replace("</style>", BANNER_CSS + hide + "</style>", 1)
    page = page.replace("<body>", "<body>\n" + banner(task), 1)
    marker = page.rfind("<script>")
    if marker == -1:
        sys.exit("map page has no <script>")
    return page[:marker] + shim + page[marker:]


# ---------- A: today's view ----------


def css_variables() -> str:
    page = MAP_PAGE.read_text()
    root = re.search(r":root \{.*?\n\}", page, re.S)
    dark = re.search(r"@media \(prefers-color-scheme: dark\) \{.*?\n\}\n", page, re.S)
    if not root or not dark:
        sys.exit("could not read the map page's colour variables")
    return root.group(0) + "\n" + dark.group(0)


def parse_diff(text: str):
    files = []
    current = None
    old = new = 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            path = line.split(" b/", 1)[-1]
            current = {"file": path, "status": "modified", "add": 0, "del": 0, "rows": []}
            files.append(current)
            continue
        if current is None:
            continue
        if line.startswith("new file mode"):
            current["status"] = "added"
        elif line.startswith("deleted file mode"):
            current["status"] = "deleted"
        elif line.startswith(("index ", "--- ", "+++ ", "similarity", "rename ", "old mode", "new mode")):
            continue
        elif line.startswith("@@"):
            match = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)", line)
            old, new = int(match.group(1)), int(match.group(2))
            current["rows"].append(("hunk", "", "", line))
        elif line.startswith("+"):
            current["rows"].append(("add", "", new, line[1:]))
            current["add"] += 1
            new += 1
        elif line.startswith("-"):
            current["rows"].append(("del", old, "", line[1:]))
            current["del"] += 1
            old += 1
        elif line.startswith(" "):
            current["rows"].append(("ctx", old, new, line[1:]))
            old += 1
            new += 1
    return files


def inline_markdown(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return text


def markdown(text: str) -> str:
    """Small Markdown renderer for the agent's summary: paragraphs, headings, code blocks,
    and lists nested by indentation (as OpenCode's terminal shows them)."""
    out, para, code = [], [], None
    stack = []  # open lists: (indent, tag)

    def close_lists(indent=-1):
        while stack and stack[-1][0] > indent:
            out.append(f"</li></{stack.pop()[1]}>")

    def flush_para():
        nonlocal para
        if para:
            out.append("<p>" + inline_markdown(" ".join(para)) + "</p>")
            para = []

    for line in text.splitlines():
        if code is not None:
            if line.strip().startswith("```"):
                out.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
                code = None
            else:
                code.append(line)
            continue
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        item = re.match(r"([-*]|\d+[.)]) (.*)", stripped)
        if stripped.startswith("```"):
            flush_para(); close_lists(); code = []
        elif not stripped:
            flush_para()
        elif item:
            flush_para()
            tag = "ol" if item.group(1)[0].isdigit() else "ul"
            if stack and indent > stack[-1][0]:
                out.append(f"<{tag}><li>")
                stack.append((indent, tag))
            else:
                close_lists(indent)
                if stack and stack[-1][0] == indent:
                    out.append("</li><li>")
                else:
                    out.append(f"<{tag}><li>")
                    stack.append((indent, tag))
            out.append(inline_markdown(item.group(2)))
        elif stack and indent > 0:
            out.append(" " + inline_markdown(stripped))
        elif re.match(r"#{1,6} ", stripped):
            flush_para(); close_lists()
            level = min(len(stripped.split(" ")[0]) + 2, 6)
            out.append(f"<h{level}>{inline_markdown(stripped.lstrip('#').strip())}</h{level}>")
        else:
            close_lists()
            para.append(stripped)
    if code is not None:
        out.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
    flush_para()
    close_lists()
    return "\n".join(out)


A_CSS = """
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--sans); }
code { font-family: var(--mono); font-size: 0.86em; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
pre code { display: block; padding: 10px 12px; overflow-x: auto; }
.top { position: sticky; top: 0; z-index: 5; padding: 10px 20px; background: var(--sheet); border-bottom: 1px solid var(--rule); }
.layout { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 0; align-items: start; }
.files { position: sticky; top: 46px; max-height: calc(100vh - 46px); overflow: auto; border-right: 1px solid var(--rule); padding: 14px 10px; }
.files h3, .main h3 { margin: 0 0 8px; font-size: 0.74rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.files a { display: flex; gap: 8px; justify-content: space-between; padding: 4px 8px; border-radius: 6px; color: var(--ink); text-decoration: none; font: 0.8rem var(--mono); }
.files a:hover { background: var(--soft); }
.files a span.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { padding: 16px 20px 60px; min-width: 0; display: grid; gap: 18px; }
.summary { background: var(--sheet); border: 1px solid var(--rule); border-radius: 12px; padding: 14px 18px; max-width: 900px; }
.summary p, .summary ul, .summary ol { margin: 6px 0; }
.summary li > ul, .summary li > ol { margin: 2px 0 6px; }
.file { background: var(--sheet); border: 1px solid var(--rule); border-radius: 12px; overflow: hidden; }
.file header { display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--rule); background: var(--soft); font: 700 0.86rem var(--mono); }
.file header .status { font: 700 0.7rem var(--sans); text-transform: uppercase; color: var(--muted); }
.counts { font: 0.8rem var(--mono); margin-left: auto; }
.a { color: var(--add); } .d { color: var(--del); }
.lines { overflow-x: auto; }
.lines table { border-collapse: collapse; font: 0.8rem/1.5 var(--mono); min-width: 100%; }
.lines td { padding: 0 8px; white-space: pre; vertical-align: top; }
.lines td.n { color: var(--muted); text-align: right; user-select: none; width: 1%; }
.lines tr.add { background: var(--add-bg); }
.lines tr.del { background: var(--del-bg); }
.lines tr.hunk td { color: var(--muted); background: var(--soft); }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } .files { position: static; max-height: none; border-right: 0; } }
"""


def build_a(task: str) -> str:
    files = parse_diff((SESSION / "final.diff").read_text())
    summary = (SESSION / "summary.md").read_text()
    total_add = sum(f["add"] for f in files)
    total_del = sum(f["del"] for f in files)
    nav = "".join(
        f'<a href="#f{i}"><span class="path">{html.escape(f["file"])}</span>'
        f'<span class="counts"><span class="a">+{f["add"]}</span> <span class="d">−{f["del"]}</span></span></a>'
        for i, f in enumerate(files)
    )
    blocks = []
    for i, f in enumerate(files):
        rows = []
        for kind, left, right, text in f["rows"]:
            sign = {"add": "+", "del": "−", "ctx": " ", "hunk": ""}[kind]
            rows.append(
                f'<tr class="{kind}"><td class="n">{left}</td><td class="n">{right}</td>'
                f'<td class="n">{sign}</td><td>{html.escape(text)}</td></tr>'
            )
        blocks.append(
            f'<section class="file" id="f{i}"><header><span>{html.escape(f["file"])}</span>'
            f'<span class="status">{f["status"]}</span>'
            f'<span class="counts"><span class="a">+{f["add"]}</span> <span class="d">−{f["del"]}</span></span></header>'
            f'<div class="lines"><table>{"".join(rows)}</table></div></section>'
        )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session changes</title>
<style>
{css_variables()}
{A_CSS}
{BANNER_CSS}
</style>
</head>
<body>
<header class="top"><strong>Session changes</strong></header>
{banner(task)}
<div class="layout">
<nav class="files"><h3>{len(files)} files changed · <span class="a">+{total_add}</span> <span class="d">−{total_del}</span></h3>{nav}</nav>
<main class="main">
<section class="summary"><h3>The agent's final message</h3>{markdown(summary)}</section>
{"".join(blocks)}
</main>
</div>
</body>
</html>
"""


def main():
    # The prompt actually used for the session (without the hidden line); falls back to study/task.md.
    source = SESSION / "task.md" if (SESSION / "task.md").exists() else STUDY / "task.md"
    task = source.read_text().strip()
    hidden = json.loads((STUDY / "hidden_change.json").read_text())["text"]
    for name, build in (("A.html", build_a), ("B.html", build_b)):
        page = build(task)
        if hidden in page or hidden.lower() in page.lower():
            sys.exit(f"{name} contains the hidden instruction text; refusing to write it")
        (OUT / name).write_text(page)
        print(f"wrote {OUT / name} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()
