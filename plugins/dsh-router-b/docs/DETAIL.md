# Partition Router

Two halves, one board.

**Host half (`dsh-host-router`).** Declarative *file partitions*: a name, an
absolute root, include/exclude globs, keywords that route free text to it,
worker concurrency, and an acceptance command list. A demand is routed to exactly
one partition (by explicit name, by the files it names, by its text, or by the
configured default — ambiguity is an error, not a coin flip), and a worker is a
real Harness subagent Session rooted in that partition directory.

**Client half (`dsh-client-ui-router`).** A right-sidebar panel that lists the
partitions, their manager and workers, and every task, grouped by what a human
can act on: active work, work still queued, and work that is finished.

## `reported` is not `verified`

This is the whole point of the board. A worker's closing message is a *claim*; it
moves a task to `reported`, which the panel renders as its own lane. Nothing but a
separate verdict moves a task to `verified` — a passing acceptance command, or a
human pressing the button in the panel. The two states are never collapsed, and
no automation is allowed to skip the intermediate one.

## What the panel offers

- Publish a demand in plain text; the router decides the partition and reports
  why it decided that.
- Read each worker's checklist, folded from the `todo/write` events of that
  worker's own Session, including the step it is on right now.
- Accept or send back a task that awaits verification, with a reason.
- Enable or disable a partition; a disabled partition accepts no new demand.

## How the two halves talk

The panel runs in the browser and cannot reach the host's services, so the host
half publishes the same facts over a small same-origin HTTP API (`/api/router/*`)
registered on the Harness web server that already serves the Web shell. No new
transport, no new declaration format, no credentials in the browser.

## Configuration

Partition roots must be absolute; `workers` is per-partition concurrency; `verify`
is the acceptance command list. A partition with no acceptance command can only
reach `reported` until a human rules on it, which is a supported state, not a
defect.

See [INTEGRATION.md](INTEGRATION.md) for the wire contract between the halves,
the exact state mapping, and the list of endpoints.
