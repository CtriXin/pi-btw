# Install and build

## From npm

```bash
pi install npm:@ctrixin-dev/pi-btw
```

Try it for one run without adding it to settings:

```bash
pi -e npm:@ctrixin-dev/pi-btw
```

## From git

```bash
pi install git:github.com/CtriXin/pi-btw@v0.59.0-fork.1
```

The `v0.59.0-fork.1` tag is created when the fork release is tagged; before that, use `@main` or a
commit ref.

Use a tag or commit ref; `pi` clones the repository into `~/.pi/agent/git/<host>/<path>` and runs
`npm install` when a `package.json` is present. The package declares `dist/index.ts`, so the clone
must be built (`npm run build`) before Pi can load it in development checkouts.

## From a local path

```bash
npm install
npm run build
pi install "$(pwd)"
```

## Relationship to the upstream package

- This repository is a fork of `@narumitw/pi-btw` v0.58.1 (MIT); see [`../NOTICE`](../NOTICE).
- The upstream package remains published. Both packages register a `/btw` command.
  Coexistence behavior has **not** been verified yet, so install only one of the two.
- `@ctrixin-dev/pi-btw` targets the Pi release pinned in `devDependencies` (currently `0.85.1`); other
  versions are unverified.

## Remove

```bash
pi remove npm:@ctrixin-dev/pi-btw
```
