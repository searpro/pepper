---
name: session-handoff
description: Carry context between Claude sessions on Pepper — pull what earlier or parallel sessions did (their transcripts on this machine, their branches and commits, docs/STATUS.md) at the start, and write the handoff into docs/STATUS.md at the end. Use when the user says "pull the context from the other session", "check your memory", "what's next", "document what we've done so the next session can pick up", or a session starts on work another session began.
---

# Session handoff

Sessions on this project run in different places: cloud sessions here, a
session on the home box that set up the server, sometimes two at once on
the same problem. None of them shares memory. Three things carry context,
in this order of trust:

1. **git**: branches, commits and their messages. Everything that was built
   is there, or it does not exist.
2. **`docs/STATUS.md`**: the handoff note. It covers where each product
   stands, what was verified on which hardware, open questions, the user's
   standing preferences, and what is next.
3. **Transcripts** of sessions that ran in *this* environment
   (`~/.claude/projects/<cwd>/*.jsonl`). A session on another machine is
   not here, only its pushes.

## Pulling context in

```bash
git fetch -q origin && git branch -r --sort=-committerdate | head -15
for b in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do
  n=$(git rev-list --count origin/main..$b); [ "$n" -gt 0 ] && echo "$b +$n $(git log -1 --format='%cs %s' $b)"
done
sed -n 1,200p docs/STATUS.md
python3 -I .claude/skills/session-handoff/transcripts.py list
```

Then, for each session that matters:

- `transcripts.py show <id>` prints what the user asked and what Claude
  concluded. `--full` keeps long replies whole.
- `transcripts.py grep '<regex>'` searches the replies of every session
  (`--all` searches tool output too).
- A transcript over a few MB is better read by the **`session-historian`**
  agent, which returns a digest and keeps the bulk out of this context.

Check what you read against git before repeating it. A plan in a transcript
may have been built since, abandoned, or merged under another name. Then
tell the user, briefly:

- What the other session found and decided.
- What of it is in `main`, and what sits on unmerged branches.
- Where it disagrees with this session's plan.
- What you will do next.

## Writing the handoff

Before a session ends, or when the user asks to "document what we've
done", update `docs/STATUS.md` in place. Keep it current; it is not a log:

- Replace the stale parts. Move finished items out of "Next".
- Record measured numbers (seconds, VRAM, RAM, the GPU) next to what they
  measure. Mark everything else "not measured".
- Write user preferences and decisions down in their own words when they
  are directives ("primary target is the local server").
- Commit it with the work it describes. A handoff that is not pushed does
  not reach the next session.

Never copy secrets, tokens, hostnames from `.env` files, or the user's
email into it.
