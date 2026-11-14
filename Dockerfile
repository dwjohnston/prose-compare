# Lane sandbox image. Based on Cloudflare's "Run OpenCode in a sandbox" guide
# (https://developers.cloudflare.com/sandbox/coding-agents/opencode/), switched to OpenCode V2.
#
# OpenCode V2 ships as the `opencode2` binary in @opencode-ai/cli (the `opencode-ai` 1.x package is V1 and
# rejects V2 `permissions` config: "V2 permissions are not supported by OpenCode V1 ... run opencode2").
# Keep OPENCODE_VERSION in src/config/harness.ts in step with this pin.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates ripgrep \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts @opencode-ai/cli-linux-x64-baseline@0.0.0-beta-19271 \
	&& ln -s /usr/local/lib/node_modules/@opencode-ai/cli-linux-x64-baseline/bin/opencode2 /usr/local/bin/opencode

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# OpenCode runs as an unprivileged user with a fresh, empty HOME per run (see src/runner/sandbox.ts).
RUN useradd --create-home --shell /bin/bash runner && mkdir -p /work && chown runner:runner /work

WORKDIR /work
CMD ["sleep", "infinity"]
