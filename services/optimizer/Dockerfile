FROM python:3.11.18-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535 AS builder
WORKDIR /app
COPY services/optimizer/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock && pip uninstall --yes pip setuptools wheel
COPY scripts/build-optimizer-runtime.py /app/build-runtime.py
RUN python /app/build-runtime.py
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
COPY --from=builder /runtime/ /
COPY --from=builder /usr/local/ /usr/local/
ENV PATH=/usr/local/bin LD_LIBRARY_PATH=/usr/local/lib SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN ["python", "-c", "import bz2, ctypes, dbm.gnu, dbm.ndbm, lzma, sqlite3, ssl, uuid; from ortools.sat.python import cp_model; assert uuid.uuid4().version == 4"]
COPY services/optimizer/optimizer /app/services/optimizer/optimizer
COPY packages/contracts /app/packages/contracts
WORKDIR /app/services/optimizer
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"]
ENTRYPOINT []
CMD ["python", "-m", "optimizer.server"]
