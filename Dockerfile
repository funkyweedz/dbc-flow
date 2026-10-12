FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY packages/client ./packages/client
ENV NODE_ENV=production PORT=4100
EXPOSE 4100
CMD ["node", "src/server.js"]
