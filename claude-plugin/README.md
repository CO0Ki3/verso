# verso plugin for Claude Code

Makes Claude write verso type tests in the packages that use verso, without being asked.

- **Skill `verso:type-tests`**: the block format, where the helpers come from, what to assert (parameters, return
  types, generic functions through `typeof f<T>`, type guards, overloads, generic type aliases) and how to fix a
  failing block without weakening it.
- **SessionStart hook**: in a repository with packages that list `verso-ts`, tells Claude which packages those are.
- **Stop hook**: before Claude finishes, runs `verso --json` in each of those packages that has changed TypeScript
  files. It sends Claude back once if a block fails, verso reports a problem, a changed file has a type error, or an
  exported function or generic type alias that Claude added, or whose signature it changed, has no block. Exports
  that were already there are left alone, so a package can adopt verso one function at a time.

## Install

```
/plugin install verso --marketplace CO0Ki3/verso
```

To pin it for everyone working on a repository, commit this to the repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "verso": { "source": { "source": "github", "repo": "CO0Ki3/verso" } }
  },
  "enabledPlugins": { "verso@verso": true }
}
```

The hooks need Node.js 22 or later and git, and run the `verso` command that the package itself installed
(`verso-ts` in its `package.json`). In a repository without verso, the plugin does nothing.

## Check

```sh
claude plugin validate .                # repository root: marketplace.json
claude plugin validate claude-plugin    # plugin.json and hooks
CLAUDE_PROJECT_DIR=<repository> node claude-plugin/scripts/session-start.mjs
echo '{"cwd":"<repository>"}' | node claude-plugin/scripts/stop.mjs
```
