# Personal .pi configuration

Intended to be used within existing projects.

---

## Setup

This project uses `Pi` inside Docker for a safe, isolated development agent.

### Prerequisites

- Docker
- Docker Compose
- At least one API key set in your environment:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`
  - or `GOOGLE_GENERATIVE_AI_API_KEY`

### Build Docker container

From the project root:

```bash
docker compose -f .pi/docker/docker-compose.yml build
```

### Start Pi in interactive mode

This will launch the Pi agent CLI inside the container using the `default` profile:

```bash
docker compose -f .pi/docker/docker-compose.yml run --rm pi
```

To use a different profile (e.g., `my_custom` that maps to `profiles/my_custom/`), set the `PI_PROFILE` environment variable:

```bash
PI_PROFILE=my_custom docker compose -f docker/docker-compose.yml run --rm pi
```

Or with extensions:

```bash
docker compose -f docker/docker-compose.yml run --rm pi -e .pi/extensions/available/purpose-gate.ts
```

