# tileward-gpu-rates

The provider list prices per GPU-hour that the [Models calculator](https://tileward.com/models/#calculator) fills its
"rate per card-hour" field from. They are other companies' prices, so they go stale; this repo is how they stay current
without a site deploy and without anyone hand-editing a file.

```
 weekly refresh ──▶ branch refresh/box-<date> ──▶ pull request ──▶ you merge it ──▶ tileward.com serves it
 (refresh/run.mjs)    (prices only; main is       (diff table,      (the approval)    (within ~10 minutes)
        │              protected)                  gpu-rates label)       ▲
        ▼                                                                 │ the site's Worker reads main, checks the shape,
 the Tileward watchdog messages you the link                              │ and serves the copy bundled with the site if
 (read-only; repeats until merged,                                        │ anything is wrong
  says so once when it clears)
```

## Who does what

| | What it does | What it cannot do |
|---|---|---|
| **The weekly refresh** (`refresh/`, run from `box/`) | Re-reads each provider's published price, compares it with `gpu-rates.json`, pushes a branch with the prices that moved, writes a heartbeat and sends you the link. A row it cannot verify keeps its old price and is named in the message. | Merge. Push to `main`. Add a card, a provider or a row. |
| **The workflow** (`open-refresh-pr.yml`) | Opens the pull request from that branch, labelled `gpu-rates`, with the change as a table and, for a move of 25% or more, the text read at the source. Refuses a branch that changes anything but `gpu-rates.json`. | Merge. |
| **You** | Read the table, check the large moves against the sources, **merge to approve** or **close to reject**. | |
| **The site's Worker** | Serves `main`'s file at `tileward.com/gpu-rates.json`, cached ten minutes, after a shape check. Falls back to the copy bundled with the site. | Serve a file that fails the check. |
| **The Tileward watchdog** | Reads this repo and the live site, read-only. Tells you when a change is waiting, when the site is not serving what `main` says, and when the refresh has stopped. | Write anything. It never merges, so merging is yours. |

## Approving a change

The pull request body is the diff table from `node validate.mjs --diff`. Rows marked ⚠ moved by 25% or more: the body quotes
what was read at the source, and `sources.md` names where. A merge to `main` **is** a publish. Close the pull request to
reject; the watchdog stops asking. A newer refresh closes an older one it supersedes.

## The refresh

```
node refresh/run.mjs              # read every source, print the verdict, change nothing
node refresh/run.mjs --write      # also write the prices that moved into gpu-rates.json
node refresh/run.mjs --report r.json --heartbeat h.json
```

Exit code: `0` nothing to change and every row read · `10` a change is proposed · `11` nothing changed but some rows could not
be read · `12` both · `1` the run failed. An unread row is never a pass.

- **What it reads:** `refresh/rows.json` has one lookup per row of `gpu-rates.json` (the instance, machine type, SKU, part
  number or table row to read, and the GPU count to divide by). `refresh/sources.mjs` reads each provider.
- **What it checks before it believes a number:** the region (Google's table is tied to the region selector shown beside it,
  CoreWeave's to its region heading), the GPU count and memory size of the row, on-demand Linux only (no Spot, Low Priority or
  Windows), exactly one matching row, a plausible price, and, on Lambda's page where the size tables are unlabelled, that the
  tables scale 8:4:2:1 in vCPUs. Anything else is `unread`, with the reason.
- **What it edits:** only the digits of a price that changed. Everything else in `gpu-rates.json` stays byte for byte, so a diff is
  only ever prices. It never changes a `basis`, a card or a provider.
- **The heartbeat:** the `agent-heartbeat` branch holds the latest run's `heartbeat.json`
  (`checked`, `changed`, `read`, `total`, `unread`) and `report.json`, force-pushed each run. `read` against `total` is what
  separates "nothing moved" from "could only reach some providers".

## The gate

```
node --test test/*.test.mjs        # the gate's own tests and the refresh's
node validate.mjs gpu-rates.json   # exit 1 and list every problem
node validate.mjs --diff old.json new.json
```

CI runs both on every pull request and on `main` and `refresh/box-*` pushes. Protect `main` so the check named `validate` is
required and changes arrive by pull request: write access to this repo is the ability to change a price on tileward.com. The
workflow that opens refresh pull requests needs the repository setting "Allow GitHub Actions to create and approve pull requests".

## Running the refresh on a host

`box/install.sh` sets the weekly job up on a host with Docker, git and curl: a systemd timer (Mondays 07:00 UTC) that runs
`box/run-weekly.sh`. The repository's Node code runs in a throwaway container with no credentials and a read-only root; the
host holds only a deploy key for this one repository (it can push a branch, and `main` is protected) and the command that
delivers messages.

```
GPU_RATES_NOTIFY='<command that reads a message on stdin and exits 0 only if it was delivered>' bash box/install.sh
```

The first run makes the key, prints its public half and stops: add it to the repository as a deploy key **with write access**,
then run it again. It then proves the job under the unit's own sandbox in a dry run, which reads the providers and pushes and
sends nothing, before it enables the timer.

```
GPU_RATES_PUSH=0 /usr/local/lib/gpu-rates/run-weekly.sh   # a dry run, any time
journalctl -u gpu-rates-refresh                            # what the last run did
bash box/uninstall.sh                                      # take it off (then delete the deploy key on GitHub)
```

A run that fails, or cannot read some rows, sends a message saying so. A run that finds nothing to change and reads every row
sends none; the heartbeat is its record.

## Adding a card, a provider or a row

A human decision, not the refresh's: edit `gpu-rates.json`, add the rows' sources to `sources.md` and a lookup for each row to
`refresh/rows.json` (a test fails for a priced row nobody refreshes), open a pull request. A provider with no reader in
`refresh/sources.mjs` needs one. The calculator reads whatever is listed.

## Files

- `gpu-rates.json` the data. One price per line; `usd` is per card-hour; `basis` says which shape and region was priced.
- `sources.md` where each price was read and every judgement call. Not served.
- `refresh/` the refresh: `run.mjs` (the verdict), `sources.mjs` (one reader per provider), `rows.json` (the lookups),
  `pr-body.mjs` (the pull request text), `lib.mjs`.
- `box/` the weekly job for a host: `install.sh`, `run-weekly.sh`, `uninstall.sh`.
- `validate.mjs`, `test/` the gate, the diff and the tests (`test/fixtures/refresh/` are real provider answers, trimmed).
- `AGENT_TASK.md` the brief for an optional scheduled cloud agent that reads the same sources by hand.
