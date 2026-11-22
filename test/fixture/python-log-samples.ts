// Real lines from a Python backend in production (gunicorn with uvicorn
// workers and a FastAPI app, read with `docker logs --since=48h <container>
// 2>&1`, without --timestamps; the container clock is UTC). Private data was
// removed before they were copied here. The whole history has only INFO
// lines and the PyJWT warning; no error and no traceback yet.
export const REAL_PYTHON_LOG_SAMPLES = [
  "[2026-11-21 19:17:52 +0000] [1] [INFO] Starting gunicorn 27.0.0",
  "[2026-11-21 19:17:52 +0000] [7] [INFO] Booting worker with pid: 7",
  "2026-11-21 19:17:57,987 - server - INFO - Cloudinary reachable",
  "/usr/local/lib/python3.12/site-packages/jwt/api_jwt.py:370: InsecureKeyLengthWarning: The HMAC key is 14 bytes long, which is below the minimum recommended length of 32 bytes for SHA256. See RFC 7518 Section 3.2.",
  "  decoded = self.decode_complete(",
  "[2026-11-21 19:18:04 +0000] [8] [INFO] Application startup complete.",
  "2026-11-21 19:18:04,277 - server - INFO - Backfilled location on 7 products",
];
