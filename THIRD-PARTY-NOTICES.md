# Third-party notices

`oc-bifrost` is MIT licensed (see [`LICENSE`](LICENSE)). It redistributes **one** third-party
component, verbatim.

## RTK — `vendor/rtk.ts`

| | |
|---|---|
| Upstream | https://github.com/rtk-ai/rtk |
| Copyright | the RTK authors (`rtk-ai`) |
| Version | `v0.50.0` |
| License | **Apache License 2.0** — full text at [`vendor/rtk-LICENSE`](vendor/rtk-LICENSE) |
| Upstream disclaimer | [`vendor/rtk-DISCLAIMER.md`](vendor/rtk-DISCLAIMER.md) |
| Modified | **no** — redistributed byte-identical |

### Not redistributed

The `rtk` **binary** is *not* bundled. The user installs it separately, from upstream. The bridge
ships only the plugin shim; the preset checks for the binary and tells you how to get it.

### Telemetry

Upstream RTK ships telemetry that is **opt-out**. See upstream's `DISCLAIMER.md` and README for how
to disable it. `oc-bifrost` itself collects no telemetry. Every outbound request it can make is
user-enabled and documented: the opt-in freshness check, the `github:` remote fetch, and the registry
install a bare name or `npm:`/`pnpm:`/`bun:` specifier asks for — that one runs your own `bun`/`npm`
and downloads from the registry you have configured.

### Affiliations

`oc-bifrost` is **not** affiliated with, endorsed by, or maintained by `rtk-ai`.
