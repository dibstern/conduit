FROM node:26.10.0-bookworm

ENV container=docker \
    DEBIAN_FRONTEND=noninteractive \
    npm_config_verify_deps_before_run=false \
    pnpm_config_verify_deps_before_run=false

# Prevent apt from starting services during the image build.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       systemd systemd-sysv dbus dbus-user-session libpam-systemd \
       build-essential python3 procps ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --allow-scripts=opencode-ai pnpm@11.17.0 opencode-ai@1.19.1 \
    && useradd --create-home --uid 1001 --shell /bin/bash conduit \
    && mkdir -p /var/lib/systemd/linger /var/log/journal /artifacts /repo \
       /home/conduit/.config/conduit /home/conduit/.claude /home/conduit/project \
    && touch /var/lib/systemd/linger/conduit \
    && chown -R conduit:conduit /artifacts /home/conduit /repo \
    && truncate -s 0 /etc/machine-id \
    && systemctl set-default multi-user.target

WORKDIR /repo
COPY --chown=conduit:conduit repo/ /repo/
USER conduit
RUN node -e 'const major = Number(process.versions.node.split(".")[0]); if (major !== 26 || Number(process.versions.node.split(".")[1]) < 10) process.exit(1)' \
    && pnpm install --frozen-lockfile \
    && pnpm build
USER root

STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/bin/bash", "/repo/test/e2e/linux-service/container-init.sh"]
