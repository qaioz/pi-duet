# duet's hosted MCP server (hosted.js). Build from the repo root:
#   docker build -f hosted/Dockerfile -t duet-mcp .
FROM node:22-alpine
WORKDIR /app
COPY package.json hosted.js panel.js transport.js ./
USER node
ENV NODE_ENV=production
CMD ["node", "hosted.js"]
