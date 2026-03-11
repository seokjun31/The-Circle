FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache vips-dev python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

RUN mkdir -p /app/uploads

EXPOSE 4000

CMD ["node", "src/index.js"]
