# Teams Extension Specification

## Overview
The Teams extension allows users to specify a team of agents they want to work with on a specific task. The extension acts as an orchestrator, delegating all work to the team.

## Location
- Integration: Run via the extension API, e.g., `pi -e extensions/team.ts`

## Core Features
1. **Team Orchestration:** The extension delegates the user's task to the selected team, managing the team's workflow and execution.
2. **Team Member Management:** Handles multiple agents working together on tasks.
3. **Session Persistence:** Remembers the active team, grid configuration, and view settings across Pi sessions.
4. **Tmux Integration:** Sub-agents can optionally be spawned inside detached `tmux` sessions, allowing the user to attach to them and observe their progress in real-time.
5. **Headless-Safe:** The extension is loaded by every `pi` invocation, including sub-agents spawned by the dispatcher. It must detect headless mode and avoid clobbering the sub-agent's environment (see "Headless Mode" below).

## Dispatcher Tool
The extension registers a single top-level tool, `dispatch_agent(agent, task)`, which the orchestrator uses to delegate work to a named team member. When a team is active in an interactive session, the extension must lock the orchestrator's active tools down to `["dispatch_agent"]` so the orchestrator cannot bypass the team. This lockdown must **not** be applied in headless mode.

## Technical Design

### Configuration
Teams configuration must support the following scenarios:

#### teams.yml
Teams must be listed in a YAML file under `agents/teams.yml` (or `agents/teams.yaml`).

Example `teams.yml` config file:
```yaml
full:
  - scout
  - planner
  - builder
  - reviewer
  - documenter
  - red-team

plan-build:
  - planner
  - builder
  - reviewer

pi-pi:
  - ext-expert
  - theme-expert
  - skill-expert
  - config-expert
  - tui-expert
  - prompt-expert
  - agent-expert
```

#### Directories

Example directory structure of agents and teams:
```
agents
├── available
│   ├── devops.md
│   ├── embedded-developer.md
│   ├── rust-coder.md
│   └── rust-planner.md
├── oracle.md
└── teams
    ├── embedded
    │   ├── devops.md -> ../../available/devops.md
    │   └── embedded-developer.md -> ../../available/embedded-developer.md
    ├── pi-experts
    │   ├── agent-expert.md
    │   ├── cli-expert.md
    │   ├── config-expert.md
    │   ├── ext-expert.md
    │   ├── keybinding-expert.md
    │   ├── pi-orchestrator.md
    │   ├── prompt-expert.md
    │   ├── skill-expert.md
    │   ├── theme-expert.md
    │   └── tui-expert.md
    └── rust
        ├── coder.md -> ../../available/rust-coder.md
        ├── devops.md -> ../../available/devops.md
        └── planner.md -> ../../available/rust-planner.md
```

Of note, `oracle.md` is an example of a single member team available in all contexts. Any agent placed directly in the root of the `agents/` directory (rather than inside a subdirectory like `available/` or `teams/`) is designated as a **global agent**. Global agents are dynamically given their own single-member team and are automatically injected into the context of *every* other team that gets activated.

The purpose of placing most agents under `agents/available/` is to avoid other agent tools automatically including them in context.
Defining teams should be as easy as creating a directory and placing `.md` files in it or linking to `.md` files. The extension must recursively scan `agents/teams/` and its subdirectories to load these definitions.

### Settings Persistence
The extension must synchronize user preferences with Pi's `settings.json`. When a user changes their active team, grid columns, or team view via commands, the following keys should be saved to persist the state:
- `defaultTeam`: The last selected team name.
- `teamGrid`: The last selected number of grid columns.
- `teamView`: The last selected view mode.
- `teamTmux`: A boolean setting to enable/disable spawning agents in tmux sessions.

### Team Activation
On `session_start`, the extension must select an active team using the following precedence:
1. `defaultTeam` from settings, if it exists and matches a loaded team.
2. Otherwise, the first team discovered (alphabetical by name) is auto-activated so the orchestrator is always usable out of the box.
3. If no teams are loaded, no team is activated and the dispatcher tool, while registered, has no agents to dispatch to.

### Headless Mode
The extension is loaded by every `pi` process, including the sub-agents that the dispatcher itself spawns with `pi --mode json -p ...`. In that context the extension must be a no-op:
- Detect headless mode by inspecting `process.argv` for `-p`, `--print`, or `--mode json`.
- When headless, `session_start` must return immediately, **without** loading agents, activating a team, or calling `pi.setActiveTools(["dispatch_agent"])`.
- Rationale: sub-agents are launched with an explicit `--tools` list (e.g. `read,grep,find,ls,bash`). If the extension overrode those with `["dispatch_agent"]`, the LLM would be left with a single tool it can't use to do real work, causing providers (notably Google Gemini) to return opaque "unknown error" responses with zero output tokens.

### Tmux Execution (When Enabled)
When `teamTmux` is enabled, the orchestrator must alter how sub-agents are spawned. The implementation has to survive several `tmux` and shell gotchas:

- **Session Naming:** Each dispatched agent runs in a detached `tmux` session with a predictable name, such as `pi-agent-<agent-name>-<timestamp>`.
- **Script File, Not Inline `bash -c`:** Sub-agent system prompts and tasks routinely contain `$`, backticks, and quotes. Build a `.sh` script file with proper single-quote escaping and run `tmux new-session -d ... bash <script>` rather than passing an inline `bash -c "..."` string.
- **Environment Propagation:** `tmux new-session` inherits the tmux *server's* environment, not the spawner's. The script must `export` every required variable (API keys, `PATH`, etc.) at its top, otherwise the sub-agent's `pi` invocation will fail to authenticate against the LLM provider.
- **Log File Pre-Creation:** The orchestrator typically watches output with `tail -f`. `tail -f` exits immediately if the file does not yet exist, so the script (or the spawner) must `touch` the log file before tail starts.
- **Real Exit Code:** When piping `pi ... | tee log`, `$?` captures `tee`'s exit code. Use `${PIPESTATUS[0]}` (bash, not sh) to capture `pi`'s actual exit code, and write it to a `.done` sentinel file the orchestrator polls.
- **Stderr Capture:** Redirect `pi`'s stderr to a `.stderr` file and read it back on completion so diagnostic errors (e.g. extension load failures) are not lost.
- **Single Resolution:** Use a `resolved` guard plus a shared `finalize()` helper so that tail-exit, sentinel-file detection, and tmux-process exit cannot resolve the dispatch promise more than once with conflicting exit codes.
- **Session Cleanup:** When the agent finishes (success or error), kill the tmux session and remove the `.log`, `.sh`, `.stderr`, and `.done` temp files.

## User Interface Requirements
The extension must include a UI that displays the team as they work.

### Team Member Cards
The UI should display team members as cards containing the following information:
- Name
- Current State
- Description
- Context Usage
- Token Usage
- Task they are currently working on

### Card Views
The UI must support multiple views for the team member cards:

- **Default:** A full card displaying:
  - Header: Agent name (bold, accented).
  - Status/Context Line: Status icon + state (colored), followed by context usage bar and token/cost info.
  - Tmux Line: (If active) Displays the tmux session name.
  - Output Area: Displays the last few lines of agent work or the agent's task/description.
- **Minimal:** A compact card displaying:
  - Header: Agent name (bold, accented).
  - Status/Context Line: Status icon + state (colored), followed by context usage bar and token/cost info.
  - Tmux Line: (If active) Displays the tmux session name.
- **Powerline:** A single-line condensed view:
  - Displays `Name | Status Icon State (Elapsed Time)`.
- **Hidden:** No cards are displayed.

### State-Based Styling
Team member cards should change color dynamically based on their current state.

## Supported Commands
The extension must support the following chat commands:
- `/team`: Select a team to work with.
- `/team-list`: List all currently loaded agents.
- `/team-grid <1-6>`: Set the number of grid columns for displaying team member cards (between 1 and 6).
- `/team-view <default|minimal|powerline|hidden>`: Set the current view mode for the team member cards.
- `/team-tmux <on|off>`: Toggle whether newly dispatched sub-agents run inside a tmux session.
