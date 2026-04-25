FROM debian:bookworm-slim

# Base tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node (required for pi)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Optional: language toolchains (keep minimal or split into variants)
# Example: Rust (optional)
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install pi agent
RUN npm install -g @mariozechner/pi-coding-agent yaml

WORKDIR /app

ENTRYPOINT ["pi"]
