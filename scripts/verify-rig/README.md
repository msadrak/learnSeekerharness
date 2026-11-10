# Verification rig

Drive a real browser against a feature without touching your running `next dev` (which holds Next's per-directory lock) or your data.
It is an isolated copy of the repo, its own data directory, and a fake model that answers every role.

```sh
node scripts/verify-rig/rig.mjs copy       # repo → ../lh-verify-copy (run again to resync after an edit; Turbopack reloads)
node scripts/verify-rig/rig.mjs install    # npm ci in the copy (about a minute)
node scripts/verify-rig/rig.mjs scratch    # ../lh-verify-scratch/data with the fake model in every slot; prints the next dev command
node scripts/verify-rig/make-scan-pdf.mjs ../lh-verify-scratch/scan.pdf --rotated   # image-only test PDF
node scripts/verify-rig/fake-llm.mjs scripts/verify-rig/handlers/annotate.mjs --log ../lh-verify-scratch/fake.jsonl
node scripts/verify-rig/rig.mjs down       # delete the copy and the scratch dir
```

Run the fake model and the copy's `next dev` (port 3100) as named background services, then drive the browser at `http://localhost:3100`.

- **Handlers** decide what the fake model says. Copy `handlers/annotate.mjs` and change it; its header documents the request fields.
- **Never** link or junction `node_modules` into the copy, and never use a git worktree: both have wiped the main repo's `node_modules`.
  `down` uses `fs.rmSync`, which unlinks symlinks and junctions instead of following them.
- The fake model proves mechanics (placement, rendering, writing, reload), not what a real model would answer.
- Paths and port are overridable with `LH_RIG_COPY`, `LH_RIG_SCRATCH` and `LH_RIG_FAKE_PORT`.
