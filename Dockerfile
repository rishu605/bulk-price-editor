# One image, two services.
#
# Web and worker run the same build and differ only in their start command, which is set
# per service in Railway. Building twice would let the two drift apart — and the pair
# that must never disagree about a price is exactly this pair, because the worker writes
# what the web process previewed.
FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the Prisma client into the image, not at boot.
#
# `npm run docker-start` runs `prisma generate && prisma migrate deploy` before starting,
# so the web service produced its own client on every boot and the image never needed one.
# The worker starts with `tsx scripts/worker.ts` and runs neither — so it imported
# `db.server.ts`, found no generated client, and crashed on every deploy with
# "@prisma/client did not initialize yet". Build succeeded, deploy succeeded, process died.
#
# Generating here is also the right split on its own terms. `generate` produces code and
# belongs to the build; `migrate` changes a database and belongs to exactly one service at
# deploy time. Bundling them into one `setup` script is what tied a build step to the web
# service's start command.
RUN npx prisma generate

RUN npm run build

# The default is the web service. The worker overrides it with `npm run worker`.
#
# That command runs through `tsx`, which is why `tsx` is a dependency rather than a dev
# dependency: with `--omit=dev` the worker image would build cleanly and then fail to
# start, and it would fail only in the deployed environment, which is the worst place to
# discover a missing package.
#
# Note what this does *not* do: migrate. `npm run docker-start` runs `prisma migrate
# deploy` first, and it is the web service's job alone — two services racing the same
# migration on deploy is a lock fight at best and a half-applied schema at worst.
CMD ["npm", "run", "docker-start"]
