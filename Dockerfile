FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cmake \
    bash

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY bot.js ./

CMD ["node", "bot.js"]