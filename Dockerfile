FROM apify/actor-node:20 AS builder
COPY package*.json ./
RUN npm install --include=dev --audit=false
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM apify/actor-node:20
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && rm -r ~/.npm
COPY --from=builder /usr/src/app/dist ./dist
COPY .actor ./.actor
CMD ["npm", "start", "--silent"]
