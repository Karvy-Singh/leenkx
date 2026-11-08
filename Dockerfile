FROM node:22-bookworm-slim
WORKDIR /app
COPY container/package*.json ./
RUN npm install --omit=dev
COPY container/server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
