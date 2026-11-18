#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「源代码.txt」（软件著作权申请用源代码样本）。

读取 ../src 下各模块与 ../public/wa.js 的真实源码，删除注释与空行后，
按“核心采集与存储在前、分析与展示在后、运行时与命令行收尾”的顺序排列。
每页 50 行，页首为左对齐「15-web-analytics V1.0」（文档页眉），页尾为
「第 N 页」，共 60 页、3000 行（不足时以空行补齐，保证登记表所称页码一致）。

A4 纵向、正文宋体五号等排版要求在各页空白处按此设定即可，TXT 源文件本身
不嵌入字体信息。

运行：python3 gen_source.py
"""
from __future__ import annotations

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT.parent / "src"
PUBLIC = ROOT.parent / "public"
OUT = ROOT / "源代码.txt"

APPLICANT_LINES = [
    "15-web-analytics V1.0",
    "著作权人：许达（工作单位：中国移动研究院）",
    "开发完成日期：2026年11月16日",
]

# 模块展示顺序：先数据链路，后分析呈现，最后服务端与命令行。
ORDER = [
    "config.js",
    "store.js",
    "schema.js",
    "privacy.js",
    "ua.js",
    "collector.js",
    "retention.js",
    "analytics.js",
    "exporter.js",
    "ratelimit.js",
    "audit.js",
    "server.js",
    "cli.js",
]

LINES_PER_PAGE = 50
PAGES = 60
FRONT_PAGES = PAGES // 2


def stripped_lines(path: pathlib.Path) -> list[str]:
    """去注释、去空行后的代码行。"""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    lines: list[str] = []
    in_block = False
    for raw in text.splitlines():
        s = raw.strip()
        if in_block:
            if "*/" in s:
                in_block = False
                tail = s[s.index("*/") + 2 :].strip()
                if tail and not tail.startswith("//"):
                    lines.append(tail)
            continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
            continue
        if s.startswith("//") or s.startswith("*") or s == "":
            continue
        if "//" in raw:
            code = raw[: raw.index("//")].rstrip()
            if code.strip():
                lines.append(code)
            continue
        lines.append(raw.rstrip())
    return lines


def banner(name: str) -> list[str]:
    return ["", f"/* ===== src/{name} ===== */", ""]


def main() -> int:
    content: list[str] = list(APPLICANT_LINES)

    for name in ORDER:
        path = SRC / name
        lines = stripped_lines(path)
        content.extend(banner(name))
        content.extend(lines)

    # 浏览器采集脚本（压缩单行）单独附后
    wa = PUBLIC / "wa.js"
    if wa.exists():
        content.extend(banner("public/wa.js"))
        content.extend(stripped_lines(wa))

    # 去掉首尾多余空行，得到有效行
    body = [ln for ln in content if ln.strip()]
    keep = PAGES * LINES_PER_PAGE  # 3000 行
    if len(body) < keep:
        body = body + [""] * (keep - len(body))
    else:
        body = body[:keep]

    out: list[str] = []
    for i in range(PAGES):
        page = body[i * LINES_PER_PAGE : (i + 1) * LINES_PER_PAGE]
        out.append(f"{APPLICANT_LINES[0]}")  # 页眉
        out.extend(page)
        out.append(f"  第 {i + 1} 页")  # 页脚

    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"generated {OUT} ({OUT.stat().st_size} bytes, {len(out)} lines, {PAGES} pages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
