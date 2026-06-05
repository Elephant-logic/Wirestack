# WireStack Studio — Claude + OpenAI build

Open `index.html` in a browser.

Changes added in this version:

- Provider selector: Claude or OpenAI
- Editable model ID field
- Separate key format hints for Anthropic/OpenAI keys
- Claude still uses Anthropic Messages streaming
- OpenAI uses the Responses streaming endpoint
- Same blueprint/wiring/knowledge/testing context is sent to either provider
- Extracted fenced code blocks still work the same way

Note: this prototype calls APIs directly from the browser. For a real product, move API calls to a small backend/proxy so keys are not exposed in the browser.

## Wizard Mode update (v2 fixes)

- Build step now shows AI message count and code block count so you can tell if the AI actually ran
- Source step pre-selects current creation mode; textarea and mode select now sync live on every keystroke (not just on "Run step")
- Overview "Build flow" panel now has a "Wizard ↗" shortcut so guided mode and wizard mode feel connected rather than competing
- wizardHint states: green border when step is done, amber when needs action

This build adds a top-level Wizard Mode for the main WireStack loop:

1. Start from an idea, guide/spec, or old project manifest.
2. Choose Claude or OpenAI and review API key safety.
3. Review the generated blueprint and capture a baseline.
4. Build with the selected AI provider.
5. Run validation, tests, Qutri scan, App Brain and health checks.
6. Run Blueprint Diff and export the project state.

### API key safety
This is still a browser-only prototype. API keys entered into the UI are used directly from the browser. For real use, place provider calls behind a local or server-side proxy.

### Model defaults
Defaults are editable. This build uses `claude-sonnet-4-6` for Claude and `gpt-5.5` for OpenAI, but the model field remains user-configurable.

## v3 workflow upgrades

This build adds the prioritized integration improvements:

- Saved AI prompt templates for build, repair, explain, tests, security review, and diff explanation.
- Context-aware AI prompt injection from Validator, Testing, Qutri, Diff, Knowledge, wiring nodes, and graph concepts.
- Local multi-file/project import. Choose files or a folder in the Importer tab and WireStack builds a manifest from text-like files without uploading them anywhere by itself.
- Knowledge graph visual cloud with weighted confidence tags and relationship cards.
- Improved wiring map with a force-style layout, SVG edges, node click actions, and dependency highlighting.

The browser API-key warning still applies: this is a local/private prototype, not a production server-backed app.

## v3.1 cleanup notes

This build adds three workflow refinements:

- **Cached wiring layout**: the force-directed wiring map only recomputes when the blueprint structure, wiring, layers, or diagram size changes.
- **Compact repair context**: AI repair prompts now receive summarized validation/testing/Qutri/diff signals instead of large raw JSON blobs.
- **Code-aware project import**: real folder/file imports now run through a separate project analyzer that extracts files, symbols, imports, package dependencies, internal edges, inferred modules, and a project-specific knowledge graph before merging into the blueprint.

## Optional Local Runner: real apply + run + test loop

The static browser app can understand, plan, generate, and analyse. To actually write generated code to files and run tests, use the included local runner.

### Start the runner

```bash
cd wirestack
npm install
npm run runner
```

It starts at:

```text
http://localhost:8787
```

The runner writes generated files into:

```text
wirestack/workspace/
```

### Browser workflow

1. Open `index.html`.
2. Go to **AI Build**.
3. Ask for a change or app build.
4. When code blocks appear, click **Apply files to runner**.
5. Click **Run real tests**.
6. If tests fail, WireStack loads a repair prompt with the real runner output.
7. Send that prompt to AI, apply the corrected files, and run again.

### What the runner can test

- JavaScript syntax with `node --check`
- JSON parsing
- Python syntax with `python3 -m py_compile` if Python is installed
- Basic SQL sanity checks
- `npm test` when the generated workspace has a `package.json` with a test script
- `python3 -m unittest discover` for Python projects

This is intentionally local-first. Do not expose the runner publicly on the internet.


## Chat-first finished-app loop

This version is designed so you can mostly talk to WireStack instead of manually driving every engine.

1. Start the local runner:
   ```bash
   npm install
   npm run runner
   ```
2. Open `index.html` in your browser.
3. Add your OpenAI or Claude API key in the top bar.
4. Go to **AI Build**.
5. Type normally, for example:
   ```text
   Build me a small booking app for dog groomers with customers, calendar, reminders and payments.
   ```
6. Press **Auto build / run / fix**.

WireStack will:

- understand the chat request,
- update the blueprint and wiring,
- ask the selected AI for real files,
- extract file code blocks,
- write them to `./workspace`,
- install/check dependencies where possible,
- run real syntax/tests through the local runner,
- feed real errors back to AI for repair,
- repeat up to 3 repair loops,
- package the app when tests pass.

Packaging notes:

- Static/web projects are bundled into `workspace/dist`.
- Python projects can become `.exe` if `pyinstaller` is installed and the code has a clear entry file.
- Electron/Node desktop apps can become `.exe` if the generated project includes an Electron packaging script.
- Packaging is blocked if tests fail.

This is still a local prototype. The static hosted UI alone cannot safely run arbitrary code; the local runner is what executes and tests generated projects.

## AI Team roles

WireStack now has an **AI Team** tab.

Use it to choose how AI work is routed:

- **OpenAI only**: OpenAI handles all chat/build/test/review tasks.
- **Claude only**: Claude handles all chat/build/test/review tasks.
- **Dual mode**: OpenAI is used for Builder/Tester work; Claude is used for Architect/Reviewer/Security work.
- **Specialist team roles**: manually assign provider and model per role.

Default recommended setup:

- Architect: Claude
- Builder: OpenAI
- Tester: OpenAI
- Security: Claude
- Reviewer: Claude

You can still just chat normally in **AI Build**. WireStack classifies your request and selects the most relevant role automatically.
