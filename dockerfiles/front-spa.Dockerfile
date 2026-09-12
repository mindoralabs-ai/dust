FROM node:24.16.0-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build

RUN npm install -g npm@11.11.0

WORKDIR /app
COPY package.json package-lock.json ./
COPY sdks/js/package.json ./sdks/js/
COPY sparkle/package.json ./sparkle/
COPY front/package.json ./front/
COPY front-spa/package.json ./front-spa/
RUN --mount=type=cache,id=npm-cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund \
      -w sdks/js -w sparkle -w front -w front-spa

COPY sdks/js ./sdks/js
RUN npm -w sdks/js run build
COPY sparkle ./sparkle
RUN npm -w sparkle run build
COPY front ./front
COPY front-spa ./front-spa

ARG COMMIT_HASH
ARG NEXT_PUBLIC_DUST_API_URL
ARG NEXT_PUBLIC_DUST_APP_URL
ENV VITE_COMMIT_HASH=${COMMIT_HASH}
ENV VITE_DUST_API_URL=${NEXT_PUBLIC_DUST_API_URL}
ENV NEXT_PUBLIC_DUST_API_URL=${NEXT_PUBLIC_DUST_API_URL}
ENV NEXT_PUBLIC_DUST_APP_URL=${NEXT_PUBLIC_DUST_APP_URL}
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm -w front-spa run build:app

FROM nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b AS front-spa

COPY dockerfiles/front-spa.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/front-spa/dist/app /usr/share/nginx/html
COPY LICENSE /usr/share/licenses/dust/LICENSE

ARG COMMIT_HASH
ARG COMMIT_HASH_LONG
ARG DD_GIT_REPOSITORY_URL=https://github.com/dust-tt/dust
ARG DD_GIT_COMMIT_SHA=${COMMIT_HASH_LONG}
ENV NEXT_PUBLIC_COMMIT_HASH=${COMMIT_HASH}
ENV DD_GIT_REPOSITORY_URL=${DD_GIT_REPOSITORY_URL}
ENV DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}

EXPOSE 8080
