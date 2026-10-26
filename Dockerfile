# Runs the agent in a container, so the only part of your machine it can touch is the one folder you mount.
# It runs as the unprivileged node user, with nothing from the host but that folder and the API key.
#   docker build -t tiny-agent .
#   docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD/some-copy:/work" tiny-agent "make the tests pass"
# MODEL and CONFIG work as with npm run agent: add -e MODEL=haiku -e CONFIG=bare.
FROM node:22-slim
WORKDIR /agent
COPY src ./src
COPY scripts ./scripts
COPY package.json prices.json ./
USER node
WORKDIR /work
ENTRYPOINT ["node", "--experimental-strip-types", "--no-warnings", "/agent/scripts/agent.ts", "/work"]
