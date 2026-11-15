FROM python:3.11.17-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce AS builder
WORKDIR /app
COPY services/optimizer/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock && pip uninstall --yes pip setuptools wheel
COPY scripts/build-optimizer-runtime.py /app/build-runtime.py
RUN python /app/build-runtime.py
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2
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
