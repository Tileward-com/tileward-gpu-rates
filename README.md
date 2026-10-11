# tileward-gpu-rates

The provider list prices per GPU-hour that the [Models calculator](https://tileward.com/models/#calculator) fills its
"rate per card-hour" field from. They are other companies' prices, so they go stale; this repo is how they stay current
without a site deploy and without anyone hand-editing a file.

```
 weekly agent task ──▶ pull request ──▶ you merge it ──▶ tileward.com serves it (within ~10 minutes)
   (AGENT_TASK.md)       (diff table)     (the approval)        ▲
                              │                                 │ the site's Worker reads main, checks the shape,
                              ▼                                 │ and serves the copy bundled with the site if
                     the Tileward watchdog messages you         │ anything is wrong
                     (read-only; repeats until merged,
                      says so once when it clears)
```

## Who does what

| | What it does | What it cannot do |
|---|---|---|
| **The agent task** (`AGENT_TASK.md`) | Re-reads each provider's published price, rebuilds `gpu-rates.json`, runs the gate, opens a pull request with the change as a table. Writes a heartbeat when nothing changed. | Merge. Edit anything but the data and its sources. Add a card or provider (it can only suggest one). |
| **You** | Read the table, check the large moves against the sources, **merge to approve** or **close to reject**. | |
| **The site's Worker** | Serves `main`'s file at `tileward.com/gpu-rates.json`, cached ten minutes, after a shape check. Falls back to the copy bundled with the site. | Serve a file that fails the check. |
| **The Tileward watchdog** | Reads this repo and the live site, read-only. Tells you when a change is waiting, when the site is not serving what `main` says, and when the agent task has stopped. | Write anything. It never merges, so merging is yours. |

## Approving a change

The pull request body is the diff table from `node validate.mjs --diff`. Rows marked ⚠ moved by 25% or more: open the
source named in `sources.md` and confirm before merging. A merge to `main` **is** a publish. Close the pull request to
reject; the watchdog stops asking.

## The gate

```
node --test test/*.test.mjs        # the gate's own tests
node validate.mjs gpu-rates.json   # exit 1 and list every problem
node validate.mjs --diff old.json new.json
```

CI runs both on every pull request. Protect `main` so the check is required and a review is needed: write access to this
repo is the ability to change a price on tileward.com.

## Adding a card or a provider

A human decision, not the agent's: edit `gpu-rates.json`, add the rows and their sources to `sources.md`, open a pull
request. The calculator reads whatever is listed.

## Files

- `gpu-rates.json` the data. One price per line; `usd` is per card-hour; `basis` says which shape and region was priced.
- `sources.md` where each price was read and every judgement call. Not served.
- `AGENT_TASK.md` the scheduled agent's whole brief.
- `validate.mjs`, `test/` the gate and the diff.
