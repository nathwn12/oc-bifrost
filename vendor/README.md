# vendor/

Third-party code redistributed with oc-bifrost. **Nothing here is modified.**

## `rtk.ts`

| Field | Value |
|---|---|
| Upstream | [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) |
| Upstream path | `hooks/opencode/rtk.ts` |
| Version | `v0.50.0` |
| Git blob | `c4450cfa999898fb67d4a09ef2cabaa19296724d` |
| sha256 | `6530c131946c84892f9522abd68d4e513e1e658d8ddbad1f59388c86ebbcb6bb` |
| Bytes | 1339 |
| License | Apache-2.0 — full text in `rtk-LICENSE` |
| Upstream disclaimer | `rtk-DISCLAIMER.md` |
| **Changes** | **none — byte-identical** |

### Why it is vendored

Upstream's own installer documents writing this file to
`~/.config/opencode/plugins/rtk.ts` (see upstream `hooks/opencode/README.md`). That is a plugin
**discovery** directory. OpenCode V2 loads a bare `.ts` file found there *directly* and hard-rejects
a V1 module — before oc-bifrost can ever see it. So the documented install path is precisely the one
that breaks.

Vendoring lets the `preset:rtk` spec mount the same bytes from a location V2 never scans.

Because the file is unmodified, Apache-2.0's "state your changes" clause is not triggered. The full
license text travels alongside as `rtk-LICENSE`.

### Updating this copy

The pin lives in **three** places that must never drift: the bytes in `vendor/rtk.ts`, the
provenance in `vendor/rtk.meta.json` (and the table above), and the version in `src/preset.ts`.
`test/provenance.test.js` fails the suite if they diverge.

**Primary path — the updater.**

```sh
npm run vendor:update                          # latest upstream release (network)
npm run vendor:update -- --ref v0.51.0         # a specific tag
npm run vendor:update -- --from-file ./rtk.ts --expect-sha256 <hex>   # offline / CI
npm run vendor:update -- --dry-run             # show the writes, change nothing
```

It resolves the tag, downloads `hooks/opencode/rtk.ts`, then **verifies the bytes against an
independent record** before writing anything:

- **Network path** — our computed git blob must equal GitHub's own recorded blob id for the file
  at that ref (the contents API's `sha`).
- **Offline path** (`--from-file`) — there is no third party to ask, so an independently obtained
  digest is required: `--expect-sha256 <hex>` or `--expect-blob <sha1>`. Without one, a real run
  refuses to write. `--dry-run` still runs but says loudly that no verification was possible.

A cheap sanity check (not a verification gate) rejects content that is empty, larger than 64 KiB,
an HTML error page, or has no source shape at all — the updater writes bytes it downloaded.

It then writes `vendor/rtk.ts`, refreshes `vendor/rtk.meta.json`, rewrites the table above,
updates the pin in `src/preset.ts`, and runs `npm run check`. If the check fails it prints the
exact revert: `git checkout -- vendor src/preset.ts`.

**Fallback — manual.**

1. Fetch `hooks/opencode/rtk.ts` at a new tag.
2. Record the new byte length, git blob, and sha256 in the table above **and** in `vendor/rtk.meta.json`.
3. Update the pinned version in `src/preset.ts`.
4. Keep `rtk-LICENSE` current; Apache-2.0 permits redistribution with the license retained.
