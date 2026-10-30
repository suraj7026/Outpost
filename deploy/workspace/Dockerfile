FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash bash-completion build-essential ca-certificates curl git jq less \
    openssh-client pkg-config procps python3 python3-venv ripgrep tini tmux unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /opt/workspace/node_modules/.bin/pi /usr/local/bin/pi \
    && ln -s /opt/workspace/node_modules/.bin/playwright /usr/local/bin/playwright \
    && ln -s /home/node/projects /workspace

COPY workspace-init browser-check /usr/local/bin/
COPY bash_profile tmux.conf /opt/workspace/defaults/
RUN chmod 755 /usr/local/bin/workspace-init /usr/local/bin/browser-check

ENV HOME=/home/node \
    NODE_PATH=/opt/workspace/node_modules \
    PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    npm_config_prefix=/home/node/.local \
    npm_config_cache=/home/node/.cache/npm \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    PI_CLIPBOARD_OSC52=1 \
    TERM=xterm-256color
USER 1000:1000
WORKDIR /home/node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/workspace-init"]
