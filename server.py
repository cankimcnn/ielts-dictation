from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "audio_cache"
CACHE_DIR.mkdir(exist_ok=True)
DATA_DIR = Path(os.environ.get("DICTATION_DATA_DIR", ROOT / "data"))
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "dictation.db"
ACCESS_TOKEN = os.environ.get("DICTATION_TOKEN", "").strip()
DATA_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialize_db():
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                attempts INTEGER NOT NULL DEFAULT 0,
                correct INTEGER NOT NULL DEFAULT 0,
                current_group INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS word_progress (
                word_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                review_streak INTEGER NOT NULL DEFAULT 0,
                due_at INTEGER NOT NULL DEFAULT 0,
                wrong_count INTEGER NOT NULL DEFAULT 0,
                last_answer_at INTEGER NOT NULL DEFAULT 0,
                dismissed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word_id TEXT NOT NULL,
                submitted_answer TEXT NOT NULL,
                expected_answer TEXT NOT NULL,
                is_correct INTEGER NOT NULL,
                answered_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_word_progress_due
            ON word_progress(status, due_at);

            CREATE INDEX IF NOT EXISTS idx_attempts_answered_at
            ON attempts(answered_at);
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(word_progress)")}
        if "dismissed" not in columns:
            db.execute("ALTER TABLE word_progress ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0")


def backup_db():
    if not DB_PATH.exists():
        return
    backup_path = BACKUP_DIR / f"dictation-{datetime.now():%Y-%m-%d}.db"
    if not backup_path.exists():
        with connect_db() as source, sqlite3.connect(backup_path) as target:
            source.backup(target)
    backups = sorted(BACKUP_DIR.glob("dictation-*.db"), reverse=True)
    for old_backup in backups[30:]:
        old_backup.unlink(missing_ok=True)


class DictationHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "database": str(DB_PATH)})
            return
        if parsed.path == "/api/progress":
            if not self.authorized():
                return
            self.get_progress()
            return
        if parsed.path == "/api/tts":
            self.serve_tts(parsed.query)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/progress":
            if not self.authorized():
                return
            self.save_progress()
            return
        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/progress":
            if not self.authorized():
                return
            self.reset_progress()
            return
        self.send_error(404)

    def end_headers(self):
        if self.path == "/" or self.path.startswith("/?") or self.path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def authorized(self):
        if not ACCESS_TOKEN:
            return True
        supplied = self.headers.get("Authorization", "")
        if supplied == f"Bearer {ACCESS_TOKEN}":
            return True
        self.send_json({"error": "Unauthorized"}, status=401)
        return False

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 5_000_000:
                raise ValueError("Invalid request size")
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, status=400)
            return None

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def get_progress(self):
        with connect_db() as db:
            state = db.execute("SELECT * FROM app_state WHERE id = 1").fetchone()
            rows = db.execute("SELECT * FROM word_progress").fetchall()
        if state is None and not rows:
            self.send_json({"exists": False})
            return
        words = {
            row["word_id"]: {
                "status": row["status"],
                "reviewStreak": row["review_streak"],
                "dueAt": row["due_at"],
                "wrongCount": row["wrong_count"],
                "lastAnswerAt": row["last_answer_at"],
                "dismissed": bool(row["dismissed"]),
            }
            for row in rows
        }
        self.send_json({
            "exists": True,
            "progress": {
                "words": words,
                "attempts": state["attempts"] if state else 0,
                "correct": state["correct"] if state else 0,
                "currentGroup": state["current_group"] if state else 1,
                "updatedAt": state["updated_at"] if state else 0,
            },
        })

    def save_progress(self):
        payload = self.read_json()
        if payload is None:
            return
        meta = payload.get("meta") or {}
        words = payload.get("words") or {}
        replace = bool(payload.get("replace"))
        attempt = payload.get("attempt")
        try:
            with connect_db() as db:
                if replace:
                    db.execute("DELETE FROM word_progress")
                db.execute(
                    """
                    INSERT INTO app_state(id, attempts, correct, current_group, updated_at)
                    VALUES(1, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        attempts=excluded.attempts,
                        correct=excluded.correct,
                        current_group=excluded.current_group,
                        updated_at=excluded.updated_at
                    """,
                    (
                        int(meta.get("attempts", 0)),
                        int(meta.get("correct", 0)),
                        max(1, int(meta.get("currentGroup", 1))),
                        int(meta.get("updatedAt", 0)),
                    ),
                )
                for word_id, state in words.items():
                    if not isinstance(word_id, str) or not isinstance(state, dict):
                        continue
                    db.execute(
                        """
                        INSERT INTO word_progress(word_id, status, review_streak, due_at, wrong_count, last_answer_at, dismissed)
                        VALUES(?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(word_id) DO UPDATE SET
                            status=excluded.status,
                            review_streak=excluded.review_streak,
                            due_at=excluded.due_at,
                            wrong_count=excluded.wrong_count,
                            last_answer_at=excluded.last_answer_at,
                            dismissed=excluded.dismissed
                        """,
                        (
                            word_id,
                            str(state.get("status", "new")),
                            int(state.get("reviewStreak", 0)),
                            int(state.get("dueAt", 0)),
                            int(state.get("wrongCount", 0)),
                            int(state.get("lastAnswerAt", 0)),
                            1 if state.get("dismissed") else 0,
                        ),
                    )
                if isinstance(attempt, dict):
                    db.execute(
                        """
                        INSERT INTO attempts(word_id, submitted_answer, expected_answer, is_correct, answered_at)
                        VALUES(?, ?, ?, ?, ?)
                        """,
                        (
                            str(attempt.get("wordId", "")),
                            str(attempt.get("submittedAnswer", "")),
                            str(attempt.get("expectedAnswer", "")),
                            1 if attempt.get("isCorrect") else 0,
                            int(attempt.get("answeredAt", 0)),
                        ),
                    )
            backup_db()
            self.send_json({"ok": True})
        except (ValueError, TypeError, sqlite3.Error) as exc:
            self.send_json({"error": str(exc)}, status=400)

    def reset_progress(self):
        with connect_db() as db:
            db.execute("DELETE FROM attempts")
            db.execute("DELETE FROM word_progress")
            db.execute("DELETE FROM app_state")
        self.send_json({"ok": True})

    def serve_tts(self, query_string: str):
        term = urllib.parse.parse_qs(query_string).get("q", [""])[0].strip()
        if not term or len(term) > 200:
            self.send_error(400, "Invalid word or phrase")
            return

        cache_key = hashlib.sha256(term.lower().encode("utf-8")).hexdigest()
        cache_file = CACHE_DIR / f"{cache_key}.mp3"
        try:
            if cache_file.exists():
                audio = cache_file.read_bytes()
            else:
                params = urllib.parse.urlencode({
                    "ie": "UTF-8",
                    "client": "tw-ob",
                    "tl": "en-GB",
                    "q": term,
                })
                request = urllib.request.Request(
                    f"https://translate.google.com/translate_tts?{params}",
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                with urllib.request.urlopen(request, timeout=15) as response:
                    audio = response.read()
                if not audio:
                    raise ValueError("Empty audio response")
                cache_file.write_bytes(audio)

            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "public, max-age=31536000")
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            print(f"TTS error for {term!r}: {exc}", file=sys.stderr)
            self.send_error(502, "Unable to load pronunciation")


if __name__ == "__main__":
    initialize_db()
    backup_db()
    host = os.environ.get("DICTATION_HOST", "127.0.0.1")
    port = int(os.environ.get("DICTATION_PORT", "4173"))
    print(f"IELTS dictation: http://{host}:{port}")
    ThreadingHTTPServer((host, port), DictationHandler).serve_forever()
