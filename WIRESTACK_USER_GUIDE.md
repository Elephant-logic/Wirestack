# WireStack Studio — User Guide

WireStack is a browser-based AI development tool. You describe an app, it builds a living blueprint of modules, wiring, and rules, and then you use that blueprint to ground every AI build and repair conversation. No install, no server, no build step — open `index.html` and go.

---

## Getting started

**1. Open the file**
Open `index.html` directly in Chrome or Firefox. Nothing to install.

**2. Add your API key**
Enter a Claude (Anthropic) or OpenAI key in the top bar. The key is used directly from your browser — don't share the page with a key entered, and don't use it on a public or shared machine. For anything beyond local testing, put the API calls behind a server proxy.

**3. Pick a provider and model**
Select Claude or OpenAI from the provider dropdown. The model field is editable — change it if you want to use a newer or different model than the default.

---

## The normal path — use the Wizard

The Wizard tab is the recommended starting point. It walks you through the full WireStack loop in six steps without requiring you to touch the engine tabs directly.

**Step 1 — Source**
Paste in an idea, a spec, a README, an old project manifest, or just a sentence describing what you want to build. Select the creation mode that best matches your input (idea, guide, old project, folder manifest).

**Step 2 — Provider**
Confirm your API key and model. The step turns green when a valid key format is detected.

**Step 3 — Blueprint**
WireStack generates a structured blueprint: named modules, wiring between them, layers, purpose statements, build rules, and a changelog. Review it here and capture a baseline snapshot before you start building — you'll use this for diffing later.

**Step 4 — Build**
Send the grounded blueprint context to the AI. Use the prompt templates (build from blueprint, repair, explain a module, write tests, security review, diff explanation) to avoid writing the same prompts from scratch every time. The AI response streams in; any fenced code blocks are extracted automatically.

**Step 5 — Verify**
Run validation, testing, Qutri scan, health score, and blueprint diff in sequence. Each engine reads the current blueprint state and reports back. If something is wrong the repair flow pre-fills an AI prompt with the specific errors — you don't need to copy-paste anything.

**Step 6 — Export**
Save a snapshot, download the project manifest, or copy it to clipboard. The export includes the blueprint, all module code, a generated file tree, and a README.

---

## The engine tabs

The Engines drawer (top right, dashed border) gives you direct access to the underlying systems. You don't need these for the normal Wizard loop, but they're useful when you want to inspect or tune something specific.

**Importer**
Paste in a guide, spec, or README, or use the file/folder picker to import a real local project. For folder imports, WireStack reads up to 160 text files locally in your browser — nothing is uploaded anywhere. It extracts modules, symbols, import edges, package dependencies, and internal wiring, then merges them into the blueprint.

**Knowledge Graph**
Visualises what WireStack has learned about your project as a weighted tag cloud. Larger tags = higher confidence. Click any tag or relationship card to send an explain prompt straight to AI Build.

**Blueprint**
The raw blueprint document and living index. You can read or edit the blueprint text directly here.

**Wiring**
Force-directed map of all modules and their connections. Nodes are positioned by architectural layer. Click any node to highlight its dependencies and dependants, and to pre-fill an explain prompt in AI Build. On projects with more than 70 modules the layout switches to a stable grid-by-layer view.

**Sections**
Searchable list of all module cards — purpose, layer, dependencies, dependants, and generated code.

**AI Workflow**
Direct AI Build interface with prompt templates, streaming response, extracted code blocks, and conversation history.

**Validator**
Checks the blueprint for structural issues: missing wires, broken dependencies, empty code blocks, missing changelog entries, malformed fences. Run this after every build cycle. Errors are summarised and can be sent directly to the AI repair flow.

**Testing**
Continuous testing and watchdog engine. Runs function checks, edge case checks, and user journey tests against the current module code. Shows a confidence score and an impact retest queue — the modules most likely affected by recent changes.

**Change Memory**
Timeline of every change recorded in the blueprint changelog. Useful for understanding what changed, when, and why.

**Agents**
Multi-agent workspace. Runs specialist agent passes (architect review, security review, UX review) and collects their findings into a shared workspace packet.

**Deploy**
Deployment readiness check and generated deployment file stubs (Dockerfile, CI config, environment setup).

**App Brain**
Visual brain map of the application — modules as nodes, with connection strength and inferred intelligence about each node's role.

**Qutri Logic**
Four-state confidence engine. Every module is rated:
- **Verified** — safe to build on
- **Partial** — works partly; add tests or docs
- **Unknown** — needs investigation before touching
- **Conflicted** — repair before building on this module

Run Qutri after building or after significant changes. Conflicted modules can be sent directly to the AI repair flow.

**Blueprint Diff**
Compares the current blueprint against a saved baseline. Shows health delta, risk change, module additions/removals, wiring changes, Qutri state changes, and impact radius. Run this before exporting or handing off.

**State**
Current snapshot, autosave toggle, save/load/download controls, and a raw state preview. Use this to pause and resume work across sessions.

**Export**
Generated file tree and project manifest. Copy or download the full export including all module code files.

---

## Context injection — the workflow shortcut

In several engine tabs you'll see a "Send to AI" button. This pre-fills an AI Build prompt with the current state of that engine — validation errors, test failures, Qutri conflicts, or diff results — so you don't have to copy anything manually. The repair prompts include a compact summary of what's wrong so the AI gets the right context without burning unnecessary tokens.

Similarly, clicking a node in the Wiring diagram or a tag in the Knowledge graph will pre-fill an explain prompt and switch you to AI Build automatically.

---

## Prompt templates

AI Build has six saved templates accessible from the template bar:

- **Build from blueprint** — sends the full blueprint context and asks the AI to implement the current task
- **Repair current** — sends a compact summary of all current errors, warnings, and Qutri conflicts
- **Explain module** — asks the AI to explain a specific module's role, dependencies, and risk surface
- **Write tests** — generates test cases for the current module set
- **Security review** — runs a security-focused pass over the blueprint and code
- **Diff explanation** — asks the AI to summarise what changed between baseline and current

---

## Saving and resuming

WireStack autosaves to browser storage if you enable it in the State tab. You can also manually save a snapshot, load a previous snapshot, or download a `.wirestack.json` file to keep offline. Load it again later from the State tab to resume exactly where you left off.

---

## Tips

**Always capture a baseline before building.** The Blueprint Diff engine needs a baseline to compare against. Do it at the start of each session.

**Use Wizard for the loop, engines for inspection.** The Wizard handles the sequence. Drop into an engine tab when you need to read the detail or trigger something specific.

**Qutri before you build on anything new.** If a module is Conflicted, building on top of it compounds the problem. Run Qutri, repair, verify, then build.

**The manifest is compact by design.** When you import a real project folder, WireStack builds a structured manifest of modules, symbols, wiring, and packages — not raw source. This keeps AI prompts focused and avoids token bloat.

**Model IDs change.** The model field is editable for a reason. If your provider releases a newer model, just type it in.
