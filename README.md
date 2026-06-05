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
