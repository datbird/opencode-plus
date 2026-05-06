FROM golang:1.22-bookworm AS auth-proxy-builder

WORKDIR /src
COPY bridge/opencode-cf-auth-proxy/ ./
RUN go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/opencode-cf-auth-proxy .

FROM ubuntu:24.04 AS ubuntu-base

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Chicago \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-transport-https \
    bash \
    bash-completion \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    openssh-client \
    openssh-server \
    passwd \
    software-properties-common \
    sudo \
    tzdata \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /etc/apt/keyrings/hashicorp.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com noble main" > /etc/apt/sources.list.d/hashicorp.list \
    && curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /" > /etc/apt/sources.list.d/kubernetes.list

FROM ubuntu-base AS base

ARG OPENCODE_VERSION=1.14.39

ENV HOME=/root \
    USER=root \
    LOGNAME=root \
    OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
    OPENCODE_SERVER_PORT=4096 \
    OPENCODE_LOG_LEVEL=INFO \
    OPENCODE_WORKSPACE_DIR=/root/workspace \
    OPENCODE_REPOS_DIR=/root/repos \
    PATH=/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-compose-plugin \
    fd-find \
    fzf \
    gh \
    git \
    git-lfs \
    iproute2 \
    iputils-ping \
    jq \
    less \
    nano \
    net-tools \
    netcat-openbsd \
    nodejs \
    openssl \
    python3 \
    ripgrep \
    rsync \
    screen \
    sqlite3 \
    sshpass \
    supervisor \
    tmux \
    unzip \
    vim \
    yq \
    zip \
    zsh \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://app-updates.agilebits.com/check/1/0/CLI2/en/2.0.0/N -H "Accept: application/json" \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n1 > /tmp/op-version \
    && OP_VERSION="$(cat /tmp/op-version)" \
    && if [[ -z "${OP_VERSION}" ]]; then OP_VERSION="2.34.0"; fi \
    && curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_amd64_v${OP_VERSION}.zip" -o /tmp/op.zip \
    && unzip -q /tmp/op.zip -d /tmp/op \
    && install -m 0755 /tmp/op/op /usr/local/bin/op \
    && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared \
    && chmod 0755 /usr/local/bin/cloudflared \
    && rm -rf /tmp/op /tmp/op.zip /tmp/op-version

COPY scripts/ /usr/local/bin/
COPY bridge/opencode-plus-quota/ /opt/opencode-plus-quota/
COPY --from=auth-proxy-builder /out/opencode-cf-auth-proxy /usr/local/bin/opencode-cf-auth-proxy
COPY supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY supervisor/opencode.conf /etc/supervisor/conf.d/opencode.conf
COPY supervisor/opencode-cf-auth-proxy.conf /etc/supervisor/conf.d/opencode-cf-auth-proxy.conf
COPY supervisor/opencode-plus-quota.conf /etc/supervisor/conf.d/opencode-plus-quota.conf

RUN chmod 0755 /usr/local/bin/opencode-* /usr/local/bin/container-entrypoint /usr/local/bin/opencode-cf-auth-proxy \
    && mkdir -p /config /data /root/.ssh /run/sshd /var/log/supervisor \
    && curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" --no-modify-path \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && sed -i \
      -e 's/^#\?PermitRootLogin .*/PermitRootLogin yes/' \
      -e 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' \
      -e 's/^#\?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication yes/' \
      -e 's/^#\?UsePAM .*/UsePAM no/' \
      /etc/ssh/sshd_config \
    && ssh-keygen -A

VOLUME ["/config"]

EXPOSE 22 4096 4097

ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]

FROM base AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
    age \
    ansible \
    autossh \
    bind9-dnsutils \
    build-essential \
    cargo \
    clang \
    clang-format \
    cmake \
    docker-buildx-plugin \
    editorconfig \
    emacs-nox \
    fish \
    gdb \
    gfortran \
    golang-go \
    google-cloud-cli \
    gzip \
    htop \
    httpie \
    joe \
    kubectl \
    lld \
    lldb \
    lsof \
    llvm \
    llvm-dev \
    mariadb-client \
    mc \
    micro \
    mtr-tiny \
    neovim \
    ninja-build \
    nmap \
    openjdk-21-jdk \
    pass \
    perl \
    pipx \
    pkg-config \
    postgresql-client \
    protobuf-compiler \
    python3-pip \
    python3-venv \
    rclone \
    redis-tools \
    restic \
    ruby-full \
    rustc \
    shellcheck \
    shfmt \
    socat \
    sshfs \
    swig \
    syncthing \
    tar \
    tcpdump \
    terraform \
    traceroute \
    xz-utils \
    zstd \
    7zip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://get.helm.sh/helm-v3.19.4-linux-amd64.tar.gz -o /tmp/helm.tar.gz \
    && tar -xzf /tmp/helm.tar.gz -C /tmp \
    && install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm \
    && curl -fsSL https://github.com/helix-editor/helix/releases/download/25.07.1/helix-25.07.1-x86_64-linux.tar.xz -o /tmp/helix.tar.xz \
    && tar -xJf /tmp/helix.tar.xz -C /opt \
    && ln -sf /opt/helix-25.07.1-x86_64-linux/hx /usr/local/bin/hx \
    && ln -sf /usr/local/bin/hx /usr/local/bin/helix \
    && curl -fsSL https://github.com/jesseduffield/lazygit/releases/download/v0.57.0/lazygit_0.57.0_Linux_x86_64.tar.gz -o /tmp/lazygit.tar.gz \
    && tar -xzf /tmp/lazygit.tar.gz -C /tmp lazygit \
    && install -m 0755 /tmp/lazygit /usr/local/bin/lazygit \
    && curl -fsSL https://github.com/editorconfig-checker/editorconfig-checker/releases/download/v3.4.0/ec-linux-amd64.tar.gz -o /tmp/editorconfig-checker.tar.gz \
    && tar -xzf /tmp/editorconfig-checker.tar.gz -C /tmp bin/ec-linux-amd64 \
    && install -m 0755 /tmp/bin/ec-linux-amd64 /usr/local/bin/editorconfig-checker \
    && ln -sf /usr/local/bin/editorconfig-checker /usr/local/bin/ec \
    && curl -fsSL https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64 -o /usr/local/bin/sops \
    && chmod 0755 /usr/local/bin/sops \
    && GOBIN=/usr/local/bin go install github.com/go-delve/delve/cmd/dlv@latest \
    && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64 /tmp/helix.tar.xz /tmp/lazygit /tmp/lazygit.tar.gz /tmp/bin /tmp/editorconfig-checker.tar.gz /root/go

RUN npm install -g \
    @devcontainers/cli \
    @google/gemini-cli \
    @tailwindcss/language-server \
    bash-language-server \
    corepack \
    dockerfile-language-server-nodejs \
    eslint \
    firebase-tools \
    npm \
    pnpm \
    prettier \
    pyright \
    typescript \
    typescript-language-server \
    vscode-langservers-extracted \
    wrangler \
    yaml-language-server \
    && npm cache clean --force

RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install ruff \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install black \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install mypy \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install python-lsp-server \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install debugpy

RUN curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && mkdir -p /opt/dropbox \
    && curl -fsSL "https://www.dropbox.com/download?plat=lnx.x86_64" -o /tmp/dropbox.tar.gz \
    && tar -xzf /tmp/dropbox.tar.gz -C /opt/dropbox --strip-components=1 \
    && curl -fsSL "https://www.dropbox.com/download?dl=packages/dropbox.py" -o /usr/local/bin/dropbox \
    && chmod 0755 /usr/local/bin/dropbox \
    && printf '%s\n' '#!/bin/bash' 'exec /opt/dropbox/dropboxd "$@"' > /usr/local/bin/dropboxd \
    && chmod 0755 /usr/local/bin/dropboxd \
    && rm -f /tmp/dropbox.tar.gz

FROM dev AS full

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    exiftool \
    ffmpeg \
    ghostscript \
    gnuplot \
    graphviz \
    graphicsmagick \
    imagemagick \
    inkscape \
    jpegoptim \
    libavif-bin \
    librsvg2-bin \
    libvips-tools \
    optipng \
    pandoc \
    plantuml \
    pngquant \
    poppler-utils \
    python3-matplotlib \
    python3-pandas \
    python3-plotly \
    python3-seaborn \
    qpdf \
    tesseract-ocr \
    texlive-latex-base \
    webp \
    wkhtmltopdf \
    && rm -rf /var/lib/apt/lists/*

RUN PUPPETEER_SKIP_DOWNLOAD=true npm install -g @mermaid-js/mermaid-cli \
    && npm cache clean --force
