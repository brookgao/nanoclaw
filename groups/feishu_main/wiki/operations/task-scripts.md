# Task Scripts

> Scheduled task pre-check: bash script runs first, agent only wakes when condition met. Minimizes API credits.

## Why Use Scripts

For any recurring task, use `schedule_task`. Frequent agent invocations — especially multiple times a day — consume API credits and risk account restrictions. If a simple check can determine whether action is needed, add a `script` — it runs first, agent only called when check passes.

## How It Works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When task fires, script runs first (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — agent wakes up and receives script's data + prompt

## Always Test Script First

Before scheduling, run the script in your sandbox to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

## When NOT to Use Scripts

If a task requires judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt.

## Frequent Task Guidance

If a user wants tasks running more than ~2x daily and a script can't reduce agent wake-ups:

- Explain each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency

## Related

- [managing-groups](managing-groups.md) — scheduling tasks for other groups via `target_group_jid`
