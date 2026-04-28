FROM debian:bookworm-slim

ARG USER=pi
ARG UID=1000
ARG GID=1000

# Base tools
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    build-essential \
    git \
    tmux \
    xclip \
    && rm -rf /var/lib/apt/lists/*

# Node (required for pi)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Create user and group
RUN groupadd -g ${GID} ${USER} || true && \
    useradd -u ${UID} -g ${GID} -m -s /bin/bash ${USER}

# Install pi agent
RUN npm install -g @mariozechner/pi-coding-agent yaml \
    && pi update

COPY .pi/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ${USER}
ENV HOME=/home/${USER}

# ---------- Customize Dependencies ----------
# Optional: language toolchains (keep minimal or split into variants)
# Example: Rust (optional)
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="${HOME}/.cargo/bin:${PATH}"

WORKDIR /app

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
