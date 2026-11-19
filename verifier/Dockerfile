# airstring verification worker (Cloud Run).
#
# Build from the REPOSITORY ROOT (the image needs tools/ and out/
# next to verifier/):
#   docker build -f verifier/Dockerfile .
# Deploy: see docs/s6-deploy.md (gcloud run deploy --source uses
# this Dockerfile when it sits at the source root; the deploy doc
# gives the exact commands, including the build-from-root variant).
#
# The replay harness tools/run-node-s3.mjs imports ../out/nethack.js
# relative to itself; tools/pre-s3.js is compiled into that build
# as an Emscripten pre-js, so it is not needed at runtime.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production \
    AIRSTRING_ROOT=/app \
    VERIFIER_STORE=firestore
COPY verifier/ ./verifier/
COPY tools/run-node-s3.mjs ./tools/run-node-s3.mjs
COPY out/ ./out/
WORKDIR /app/verifier
EXPOSE 8080
CMD ["node", "server.mjs"]
