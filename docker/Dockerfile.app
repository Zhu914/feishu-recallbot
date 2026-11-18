ARG NODE_IMAGE=node:20-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY session ./session
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint
RUN chmod +x /usr/local/bin/app-entrypoint

ENV DATA_DIR=/data
ENV CONTACTS_FILE=/data/contacts.md
ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "src/index.js"]
