ARG NODE_IMAGE=node:20-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY AGENTS.md ./AGENTS.md
COPY session ./session
COPY skills ./skills
COPY tasks.json ./
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint
RUN chmod +x /usr/local/bin/app-entrypoint

ENV DEFAULT_CWD=/app
ENV CODEX_BIN=/app/node_modules/.bin/codex
ENV DATA_DIR=/data
ENV CONTACTS_FILE=/data/contacts.md
ENV TASKS_FILE=/data/tasks.json
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "src/index.js"]
