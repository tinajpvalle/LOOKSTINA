FROM node:22-alpine

WORKDIR /app

# instala dependências do backend primeiro (cache de camadas)
COPY server/package.json server/package-lock.json* /app/server/
RUN cd /app/server && npm install --omit=dev

# copia o restante do site + backend
COPY . /app

USER node
EXPOSE 4001
CMD ["node", "server/server.js"]
