FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build
COPY deployment.testnet.json ./
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 TROIA_FUNDING_MODE=manual
EXPOSE 3001
CMD ["node", "packages/composition/dist/main.js"]
