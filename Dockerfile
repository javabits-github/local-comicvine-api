# ComicVine local API — single image for both the server and the updater.
#
# Both entry points are zero-dependency Node.js (node:sqlite + fetch), so a
# single node:26-slim image serves the API and can also run a sync. There is no
# npm install step: the app has no runtime dependencies.
#
# The database is NOT baked into the image (localcv.db is gitignored and
# multi-GB). It is provided at runtime as a volume mounted at /data, and both
# the server and the updater are pointed at it via COMICVINE_DB_PATH / --db.
#
#   # serve the API
#   docker run --rm -p 3333:3333 -v ./data:/data comicvine
#
#   # run a sync inside the same image (needs the live API key)
#   docker run --rm -v ./data:/data -e COMICVINE_API_KEY=... \
#     comicvine npm run sync -- --db /data/localcv.db

FROM node:26-slim

WORKDIR /app

# No dependencies to install, so copy the source directly.
COPY package.json ./
COPY src ./src

# The database lives on a volume, not in the image.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333 \
    COMICVINE_DB_PATH=/data/localcv.db

# Declare the data mount point; the DB and its -wal/-shm sidecars live here.
VOLUME /data

EXPOSE 3333

# Default: run the API server. Run the updater with `npm run sync -- --db ...`.
CMD ["npm", "start"]
