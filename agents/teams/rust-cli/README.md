# Rust CLI Team

Agent definitions for a small team that builds asynchronous Rust 1.75 command-line tools using `clap`, `tokio`, `config`, `env_logger`/`log`, `anyhow`/`thiserror`, and (optionally) `nix` for daemonization. BDD via `cucumber-rs`; unit/integration testing via `assert_cmd`, `predicates`, `tempfile`, and `unindent`.

The agent files are plain Markdown with YAML frontmatter and load in Pi, Gemini, GitHub Copilot, and Claude-family tools.

## Roles

| Agent                    | File                          | Owns                                                                 | Reads but does not modify          |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| **Architect**            | `rust-cli-architect.md`       | `docs/features/*.feature`, `docs/plans/`                             | `src/`, `tests/`, top-level docs   |
| **Developer**            | `rust-cli-developer.md`       | `src/`, `tests/`, `Cargo.toml`, `config/`                            | `docs/features/`, top-level docs   |
| **Tester**               | `rust-cli-tester.md`          | `tests/` (step definitions, integration, property tests)             | `src/`, `docs/features/`           |
| **Reviewer**             | `rust-cli-reviewer.md`        | review verdicts only (no file writes)                                | everything                         |
| **Librarian**            | `rust-cli-librarian.md`       | `README.md`, `DEVELOP.md`, `INDEX.md`                                | `src/`, `docs/features/`           |

## Information flow

```
   user request
        │
        ▼
   Architect ── writes/updates docs/features/*.feature and a plan
        │
        ├──────────────► Tester ── implements failing cucumber-rs steps + integration tests
        │
        ▼
   Developer ── implements src/ until BDD + unit tests pass, commits one feature/bug per commit
        │
        ▼
   Reviewer  ── verdict: approve / request-changes / block
        │
        ▼
   Librarian ── updates INDEX.md change log, README/DEVELOP as needed
```

Each role's file states explicit read/write boundaries and refuses out-of-lane work. The Reviewer is the only role with no write authority — its output is structured feedback consumed by the others.
