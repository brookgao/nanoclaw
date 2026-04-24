# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# SSH client — bind-mounted host ~/.ssh lets the agent reach dev servers.
# Only groups explicitly wired in container-runner.ts (currently feishu_dm) get .ssh mounted.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — used by the agent to push branches and open PRs from any group.
# All containers receive GH_TOKEN via env (see container-runner.ts); entrypoint
# wires it into git so HTTPS and SSH-style remotes both authenticate transparently.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Install + build feishu-blocks-mcp (custom MCP server for Feishu doc/wiki access)
COPY feishu-blocks-mcp/package*.json /app/feishu-blocks-mcp/
RUN cd /app/feishu-blocks-mcp && npm install
COPY feishu-blocks-mcp/ /app/feishu-blocks-mcp/
RUN cd /app/feishu-blocks-mcp && npm run build

# Install mem0-mcp (cloud memory search/write for cross-session knowledge)
COPY mem0-mcp/package*.json /app/mem0-mcp/
RUN cd /app/mem0-mcp && npm install
COPY mem0-mcp/ /app/mem0-mcp/

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Entrypoint also backfills /etc/passwd with the running uid — ssh and other
# getpwuid() callers refuse to run without a user entry, and nanoclaw launches
# the container with --user $hostUid (e.g. 501 on macOS) which is outside the
# base image's user table.
RUN printf '#!/bin/bash\nset -e\nuid=$(id -u); gid=$(id -g)\nif ! getent passwd "$uid" >/dev/null 2>&1; then\n  echo "user:x:$uid:$gid:user:/home/node:/bin/bash" >> /etc/passwd\nfi\nif [ -n "$GH_TOKEN" ]; then\n  git config --global --add url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "git@github.com:"\n  git config --global --add url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"\nfi\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories.
# /etc/passwd made world-writable so entrypoint can append the runtime uid
# (see above) — /etc/passwd contents aren't a security boundary inside this
# container since it already runs the user's agent code.
RUN chown -R node:node /workspace && chmod 777 /home/node && chmod 666 /etc/passwd

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
