from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

from download_audio import fetch_audio


ROOT = Path(__file__).resolve().parent
WORDLIST = ROOT / "wordlist.txt"
WORDLIST_DATA = ROOT / "wordlist-data.js"
AUDIO_DIR = ROOT / "audio"
DB_PATH = ROOT / "data" / "dictation.db"


def parse_line(line: str):
    match = re.match(r"^(P\d+)\s+(\d+)\s+(.+)$", line)
    if not match:
        return None
    parts = [part.strip() for part in re.split(r"\s{2,}", match.group(3).strip()) if part.strip()]
    if not parts:
        return None
    term = parts[0]
    phonetic = parts[1] if len(parts) > 2 else ""
    meaning = parts[2] if len(parts) > 2 else parts[1] if len(parts) == 2 else ""
    return {
        "prefix": match.group(1),
        "number": match.group(2),
        "word_id": f"{match.group(1)}-{match.group(2)}",
        "term": term,
        "phonetic": phonetic,
        "meaning": meaning,
    }


def build_line(entry):
    fields = [entry["prefix"], entry["number"], entry["term"]]
    if entry.get("phonetic"):
        fields.append(entry["phonetic"])
    if entry.get("meaning"):
        fields.append(entry["meaning"])
    return "   ".join(fields)


def load_feedback():
    if not DB_PATH.exists():
        return []
    with sqlite3.connect(DB_PATH) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """
            SELECT * FROM feedback_log
            WHERE resolved_at = 0
            ORDER BY created_at, id
            """
        ).fetchall()
    return [dict(row) for row in rows]


def update_wordlist(feedback_rows, apply=False):
    lines = WORDLIST.read_text(encoding="utf-8").splitlines()
    parsed_by_id = {}
    for index, line in enumerate(lines):
        parsed = parse_line(line)
        if parsed:
            parsed_by_id[parsed["word_id"]] = (index, parsed)

    changes = []
    changed_word_ids = set()
    for row in feedback_rows:
        word_id = row["word_id"]
        if word_id not in parsed_by_id:
            changes.append({"id": row["id"], "wordId": word_id, "action": "missing-word"})
            continue
        index, entry = parsed_by_id[word_id]
        issue_types = set((row["issue_types"] or "").split(","))
        before = dict(entry)
        if "spelling" in issue_types and row["suggested_term"].strip():
            entry["term"] = row["suggested_term"].strip()
        if "meaning" in issue_types and row["suggested_meaning"].strip():
            entry["meaning"] = row["suggested_meaning"].strip()
        if entry != before:
            lines[index] = build_line(entry)
            changed_word_ids.add(word_id)
            changes.append({
                "id": row["id"],
                "wordId": word_id,
                "action": "update-wordlist",
                "before": {"term": before["term"], "meaning": before["meaning"]},
                "after": {"term": entry["term"], "meaning": entry["meaning"]},
            })
    if apply and changed_word_ids:
        text = "\n".join(lines) + "\n"
        WORDLIST.write_text(text, encoding="utf-8")
        WORDLIST_DATA.write_text("window.WORDLIST_TEXT = " + repr(text) + ";\n", encoding="utf-8")
    return changes


def update_audio(feedback_rows, apply=False):
    changes = []
    for row in feedback_rows:
        issue_types = set((row["issue_types"] or "").split(","))
        if "pronunciation" not in issue_types:
            continue
        query = row["pronunciation_query"].strip() or row["suggested_term"].strip() or row["term"].strip()
        if not query:
            changes.append({"id": row["id"], "wordId": row["word_id"], "action": "missing-pronunciation-query"})
            continue
        changes.append({"id": row["id"], "wordId": row["word_id"], "action": "replace-audio", "query": query})
        if apply:
            data, error = fetch_audio(query)
            if error:
                changes[-1]["error"] = error
                continue
            (AUDIO_DIR / f"{row['word_id']}.mp3").write_bytes(data)
    return changes


def mark_resolved(feedback_rows):
    now = int(time.time() * 1000)
    with sqlite3.connect(DB_PATH) as db:
        db.executemany(
            "UPDATE feedback_log SET resolved_at = ? WHERE id = ?",
            [(now, row["id"]) for row in feedback_rows],
        )


def main():
    parser = argparse.ArgumentParser(description="Read saved feedback and apply approved word/audio fixes.")
    parser.add_argument("--apply", action="store_true", help="Actually write wordlist/audio changes and mark feedback resolved.")
    args = parser.parse_args()

    feedback_rows = load_feedback()
    wordlist_changes = update_wordlist(feedback_rows, apply=args.apply)
    audio_changes = update_audio(feedback_rows, apply=args.apply)
    if args.apply and feedback_rows:
        mark_resolved(feedback_rows)
    print(json.dumps({
        "mode": "apply" if args.apply else "preview",
        "feedbackCount": len(feedback_rows),
        "wordlistChanges": wordlist_changes,
        "audioChanges": audio_changes,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
