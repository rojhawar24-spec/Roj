FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/data /app/public/uploads && chown -R node:node /app
ENV NODE_ENV=production
EXPOSE 3000
VOLUME ["/app/data","/app/public/uploads"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["npm","start"]
