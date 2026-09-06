# Reticle agent skills

One directory per skill, each holding a `SKILL.md`. This is the whole format. The [`skills` CLI](https://github.com/vercel-labs/skills) reads GitHub directly, so **there is no manifest to maintain and no registry to publish to.**

## Installing

```bash
npx skills add reticlehq/reticle                        # pick from the list
npx skills add reticlehq/reticle --skill install-and-verify -y   # just one, non-interactive
npx skills add reticlehq/reticle --list                 # look without installing
```

Claude Code users get the same content through the plugin (`plugin/SKILL.md`, registered in `.claude-plugin/marketplace.json`), which also registers the MCP server in the same step.

## Publishing

There is no publish step. The CLI clones this repo, walks `skills/` up to three levels, and installs every directory whose `SKILL.md` has valid frontmatter. Merging to `main` ships it. [skills.sh](https://skills.sh) builds its directory from the CLI's own anonymous install telemetry, so listing follows usage rather than a submission.

## The rules a new skill must satisfy

Frontmatter needs `name` and `description`, and the [spec](https://agentskills.io/specification) adds constraints the CLI itself does not enforce but hosts like Claude Code do:

- `name` must equal the directory name, be 1–64 chars, and use only lowercase `a-z0-9` and single hyphens.
- `description` must be 1–1024 chars, and is the only thing an agent sees when deciding whether to load the skill, so say what it does _and_ when to use it.
- Keep `SKILL.md` under 500 lines; put the long tail in `references/`.

**Quote any `description` containing a colon.** `description: Catches false greens: a green suite…` is invalid YAML, and the CLI's failure mode is to print one warning and **silently drop the skill** from the install. Two skills in this directory shipped that way. Wrap the value in single quotes.

## Checking before you push

```bash
npx skills add reticlehq/reticle --list   # every skill must appear, with zero ⚠ lines
```

A skill missing from that output is a skill nobody can install.
