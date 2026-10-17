#!/usr/bin/env python3
"""Read earlier Claude Code sessions on this checkout without loading them.

Transcripts are JSONL files of tens of megabytes (tool output included), so
this prints only what people said and what Claude concluded.

  transcripts.py list                      sessions, newest first
  transcripts.py show <id-prefix> [--full] the user's messages and Claude's replies
  transcripts.py grep <regex> [--all]      matching lines in replies (and tool output with --all)

Only sessions that ran in this environment are here. A session on another
machine (the home box, a laptop) left its context in git and docs/STATUS.md.
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.home() / '.claude' / 'projects'


def project_dir():
    here = os.getcwd()
    while True:
        candidate = ROOT / here.replace('/', '-')
        if candidate.is_dir():
            return candidate
        parent = os.path.dirname(here)
        if parent == here:
            sys.exit(f'no transcripts for {os.getcwd()} under {ROOT}')
        here = parent


def entries(path):
    with open(path, encoding='utf-8', errors='replace') as handle:
        for line in handle:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(part.get('text', '') for part in content if isinstance(part, dict) and part.get('type') == 'text')


def said(entry):
    """(who, text) for a message a person would have read, else None."""
    kind = entry.get('type')
    if kind == 'user' and not entry.get('isMeta'):
        text = text_of(entry['message'].get('content', ''))
        # Harness wrappers (command output, reminders, task notices) start with a tag.
        if text.strip() and not text.lstrip().startswith('<'):
            return 'USER', text
    if kind == 'assistant':
        text = text_of(entry['message'].get('content', []))
        if text.strip():
            return 'CLAUDE', text
    if kind == 'summary':
        return 'SUMMARY', entry.get('summary', '')
    return None


def sessions():
    found = []
    for path in project_dir().glob('*.jsonl'):
        first = next((text for who, text in filter(None, map(said, entries(path))) if who == 'USER'), '')
        found.append((path.stat().st_mtime, path, first))
    return sorted(found, reverse=True)


def resolve(prefix):
    matches = [path for _, path, _ in sessions() if path.stem.startswith(prefix)]
    if len(matches) != 1:
        sys.exit(f'{len(matches)} sessions match {prefix!r}')
    return matches[0]


def main(argv):
    if not argv or argv[0] == 'list':
        for mtime, path, first in sessions():
            when = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M')
            size = path.stat().st_size / 1e6
            print(f'{path.stem[:8]}  {when}  {size:6.1f} MB')
            print(f'          {first[:200].replace(chr(10), " ")}')
        return
    if argv[0] == 'show' and len(argv) > 1:
        limit = None if '--full' in argv else 3000
        for entry in entries(resolve(argv[1])):
            message = said(entry)
            if not message:
                continue
            who, text = message
            stamp = entry.get('timestamp', '')[:16].replace('T', ' ')
            print(f'\n=== {who} {stamp}')
            print(text if limit is None or len(text) <= limit else f'{text[:limit]}\n[… {len(text) - limit} more characters; --full shows them]')
        return
    if argv[0] == 'grep' and len(argv) > 1:
        pattern = re.compile(argv[1], re.I)
        everything = '--all' in argv
        for _, path, _ in sessions():
            for entry in entries(path):
                if everything:
                    text = json.dumps(entry.get('message', {}).get('content', ''), ensure_ascii=False)
                else:
                    message = said(entry)
                    text = message[1] if message else ''
                for line in text.splitlines():
                    if pattern.search(line):
                        print(f'{path.stem[:8]} {entry.get("timestamp", "")[:10]}: {line.strip()[:300]}')
        return
    print(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
