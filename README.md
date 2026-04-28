# Project Name

Short description of the project.

---

## Development (pi.dev)

This project uses `pi.dev` inside Docker for a safe, isolated development agent.

### Prerequisites

- Docker
- Docker Compose
- At least one API key set in your environment:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - or `GOOGLE_GENERATIVE_AI_API_KEY`

### Setup

From the project root:

```bash
docker compose -f .pi/docker/docker-compose.yml build
```

### Start pi.dev in interactive mode

This will launch the pi.dev agent CLI inside the container using the `default` profile:

```bash
docker compose -f .pi/docker/docker-compose.yml run --rm pi
```

To use a different profile (e.g., `my_custom` that maps to `.pi/profiles/my_custom/`), set the `PI_PROFILE` environment variable:

```bash
PI_PROFILE=my_custom docker compose -f .pi/docker/docker-compose.yml run --rm pi
```

