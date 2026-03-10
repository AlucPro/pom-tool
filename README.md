## pom-tool

A small **Node.js CLI** (TypeScript + pnpm) for running Pomodoro timers in your terminal, with optional **Bark** notifications synced to your phone.

## Features

- **Run a Pomodoro for N minutes**
  - `pom 25` starts a 25-minute Pomodoro.
- **View stats**
  - `pom status` shows average Pomodoro minutes for:
    - today
    - the last 7 days
    - the last 30 days
- **Bark notifications**
  - `pom bark` configures a Bark URL so the CLI can push notifications to the Bark app on your iPhone.
  - `pom bark --url <BARK_URL>` supports non-interactive setup.
- **Help**
  - `pom --help` shows the help message.
  - `pom help` shows the help message.
  - `pom -h` shows the help message.

## Requirements

- Node.js (recommended: an active LTS version)

## Install (from npm)

Install globally:

```bash
npm i -g pom-tool
```

Or use without installing (recommended for quick usage):

```bash
npx pom-tool 25
```

After installing, the command is:

```bash
pom
```

## Usage

### Start a Pomodoro

```bash
pom 25
```

### Check status / averages

```bash
pom status
```

### Configure Bark

1. Get your Bark push URL from the Bark app (it usually looks like `https://api.day.app/<your_key>`).
2. Set it via the CLI:

```bash
pom bark
```

After it’s configured, the CLI will send important notifications (for example: timer started/finished) to Bark.

For non-interactive setup:

```bash
pom bark --url https://api.day.app/<your_key>
```

## Development

This repo uses **pnpm + TypeScript**.

### Setup

```bash
git clone <your-repo-url>
cd pom-tool
pnpm install
```

### Run locally

Common workflows for Node CLIs:

- Build then run the compiled CLI:

```bash
pnpm build
node dist/index.js 25
```

- Or run directly with a TS runner (if configured in this repo later):

```bash
pnpm dev -- 25
```

### Link for local testing (global `pom`)

```bash
pnpm build
pnpm link --global
pom 25
```

To unlink:

```bash
pnpm unlink --global pom-tool
```

## Versioning

This package follows **Semantic Versioning** (SemVer): `MAJOR.MINOR.PATCH`.

## License

See `LICENSE`.
