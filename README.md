# WireStack Boom Hybrid — Full App Builder

A Boom-style chat frontend with WireStack's blueprint, Qutri, AI team, dependency manager, runner, test loop and packaging hooks behind the scenes.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy on Render

Create a **Web Service**.

```text
Build Command: npm install
Start Command: npm start
```

Environment variables:

```text
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_MODEL=gpt-5.5
ANTHROPIC_MODEL=claude-sonnet-4-5
```

Use either provider or both. If no key is present, it falls back to a local scaffold so the app still demonstrates the pipeline.

## How to use

In chat, say something like:

```text
Build a complete app from this idea and make it work: a dog grooming booking app with customers, calendar, payments, reminders, admin dashboard and tests.
```

The runner will try to:

1. Understand the idea and update the blueprint.
2. Ask the configured AI role to create files.
3. Apply files into the workspace.
4. Detect JS/Python dependencies from imports.
5. Create/update `package.json` or `requirements.txt` where needed.
6. Install dependencies.
7. Run syntax checks and tests.
8. Feed real errors back into the repair loop if possible.
9. Package only when tests pass.

## What counts as a finished app?

A generated app is considered finished when:

- files are applied,
- dependencies install,
- syntax checks pass,
- test/start checks pass,
- package output is created.

## Important limitations

- Arbitrary generated code is executed on the runner. Use this only in a trusted/private environment.
- Browser hosting as a Static Site is not enough. This needs a Node Web Service.
- Windows `.exe` packaging requires PyInstaller for Python apps or Electron tooling for Electron apps. If unavailable, the runner creates a zip package instead.
