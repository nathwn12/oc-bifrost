# oc-bifrost

**The rainbow bridge for OpenCode plugins.** Run V1-era plugin hooks on the OpenCode **V2** runtime.

OpenCode V2 intentionally broke the plugin API — a V1 plugin module is now hard-rejected at load:

> `Plugin must export a default definition with an id and an effect or setup function.`
> — `packages/core/src/plugin/module.ts`

Most plugins never got ported. `oc-bifrost` is one small plugin that loads them anyway, translates their V1 hooks onto V2 registration calls, and tells you exactly what it could not bridge.

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "@nathwn12/oc-bifrost",
      "options": {
        "plugins": [
          "./legacy/rtk.ts",
          { "spec": "./legacy/graphify-nudge.ts" }
        ]
      }
    }
  ]
}
```

## What it does

- **V1 factory** `async (input) => Hooks` → hook translation
- **V1 module** `{ id, server }` → hook translation
- **V2 definition** `{ id, setup }` → mounted with the same context

It hands V1 plugins a faithful-enough `PluginInput`: `directory`, `project`, a `$` shell (Bun's when present, a portable shim otherwise), and a `client` facade that **throws loudly** on anything it cannot provide rather than returning a plausible lie.

## Compatibility matrix

The unit of compatibility is the **V1 hook**, not the plugin. Once a hook is bridged, every plugin that uses it works untouched.

| V1 hook | Level | V2 destination |
|---|---|---|
| `tool.execute.before` | 🟢 full | `ctx.tool.hook("execute.before")` — mutation write-back verified |
| `shell.env` | 🟢 full | `ctx.shell.hook("create.before")` |
| `chat.headers` | 🟢 full | `ctx.session.hook("model.request")` |
| `permission.ask` | 🟢 full | `ctx.permission.hook("evaluate")` |
| `dispose` | 🟢 full | `setup` cleanup return |
| `tool.execute.after` | 🟡 partial | `ctx.tool.hook("execute.after")` — `title` ignored |
| `chat.params` | 🟡 partial | `ctx.session.hook("context")` |
| `chat.message` | 🟡 partial | `ctx.session.hook("prompt")` |
| `tool.definition` | 🟡 partial | `ctx.tool.transform` (apply-time snapshot) |
| `tool` | 🟡 partial | `ctx.tool.transform` editor.add |
| `event` | 🟡 partial | `ctx.event.subscribe()` — V2 event names differ |
| `experimental.chat.system.transform` | 🟡 partial | `ctx.session.hook("context")` |
| `experimental.chat.messages.transform` | 🟡 partial | `ctx.session.hook("context")` |
| `experimental.session.compacting` | 🟡 partial | `ctx.session.hook("compaction")` |
| `config` | 🔴 refused | per-domain transforms, different semantics |
| `auth` | 🔴 refused | `ctx.integration.transform` |
| `provider` | 🔴 refused | `ctx.provider.transform` / `ctx.model.transform` |
| `command.execute.before` | 🔴 refused | no one-to-one global V2 hook |
| `experimental.provider.small_model` | 🔴 refused | no V2 equivalent |
| `experimental.compaction.autocontinue` | 🔴 refused | no V2 equivalent |
| `experimental.text.complete` | 🔴 refused | no V2 equivalent |

**No hook is ever dropped silently.** Refused hooks warn at load (or abort under `strict: true`). The single source of truth is [`src/compat-matrix.ts`](src/compat-matrix.ts), and every row names the test that proves it.

## Honest bounds

This bridges **the mappable subset**, not "any plugin, seamlessly." Three V1 hooks have no V2 destination — no compatibility layer can invent one. Plugins that depend on those need a real port. The refusal list is the product being honest, and it is the contract.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `plugins` | `Array<string \| { spec, options }>` | `[]` | Modules to bridge |
| `strict` | `boolean` | `false` | Abort setup on an unsupported hook |
| `verbose` | `boolean` | `true` | Print the per-plugin compatibility report |

## Develop

```sh
npm install
npm run check      # typecheck + build + tests
```

## Contributing

Two doors, both gated on proof:
- **Add hook coverage** — edit `compat-matrix.ts`, implement the bridge, and add the test its row names.
- **Add a verified plugin** — smoke-test it and add a row to [`VERIFIED-PLUGINS.md`](VERIFIED-PLUGINS.md).

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
