# Node 24 bringt SQLite und TypeScript-Ausführung mit, es gibt keine Laufzeit-Abhängigkeiten.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production DATENBANK=/daten/bahn.sqlite PORT=3050 TZ=Europe/Berlin
VOLUME /daten
EXPOSE 3050
HEALTHCHECK --interval=1m --timeout=5s CMD node -e "fetch('http://localhost:3050/gesund').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
