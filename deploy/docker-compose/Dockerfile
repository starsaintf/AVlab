FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY tsconfig.base.json ./
RUN npm ci --ignore-scripts && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV AVLAB_SERVER_TOKEN=""
EXPOSE 4318
CMD ["sh","-c","test -n \"$AVLAB_SERVER_TOKEN\" && node apps/cli/dist/index.js server /data --token \"$AVLAB_SERVER_TOKEN\" --host 0.0.0.0 --port 4318"]
