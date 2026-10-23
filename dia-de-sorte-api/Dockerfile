FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Prisma CLI is needed by Railway's pre-deploy migration command.
RUN npm ci --include=dev
COPY . .
# Client generation reads the URL but does not connect to this build-only database.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run prisma:generate && npm run build
ENV NODE_ENV=production
USER node
CMD ["node", "dist/main.js"]
