from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
from pathlib import Path

from download_audio import fetch_audio
from audit_official_audio import first_cambridge_uk_audio, first_oxford_uk_audio, find_official_audio, request_audio


ROOT = Path(__file__).resolve().parent
WORDLIST = ROOT / "wordlist.txt"
WORDLIST_DATA = ROOT / "wordlist-data.js"
AUDIO_DIR = ROOT / "audio"
DATA_DIR = Path(os.environ.get("DICTATION_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "dictation.db"


OFFICIAL_FINDERS = (
    ("oxford", first_oxford_uk_audio),
    ("cambridge", first_cambridge_uk_audio),
)


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
            change = {
                "id": row["id"],
                "wordId": word_id,
                "action": "update-wordlist",
                "before": {"term": before["term"], "meaning": before["meaning"]},
                "after": {"term": entry["term"], "meaning": entry["meaning"]},
            }
            if before["term"] != entry["term"]:
                change["pronunciationQuery"] = entry["term"]
            changes.append(change)
    if apply and changed_word_ids:
        text = "\n".join(lines) + "\n"
        WORDLIST.write_text(text, encoding="utf-8")
        WORDLIST_DATA.write_text("window.WORDLIST_TEXT = " + repr(text) + ";\n", encoding="utf-8")
    return changes


def file_digest(path):
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_alternate_official_audio(query, target_ids):
    current_hashes = {
        file_digest(AUDIO_DIR / f"{word_id}.mp3")
        for word_id in target_ids
        if (AUDIO_DIR / f"{word_id}.mp3").exists()
    }
    current_hashes.discard("")
    candidates = []
    errors = []
    for source, finder in OFFICIAL_FINDERS:
        try:
            found = finder(query)
            if not found:
                continue
            audio_url, page_url = found
            data = request_audio(audio_url)
            digest = hashlib.sha256(data).hexdigest()
            candidate = {
                "source": source,
                "pageUrl": page_url,
                "audioUrl": audio_url,
                "data": data,
                "digest": digest,
                "matchesCurrent": digest in current_hashes,
            }
            candidates.append(candidate)
            if digest not in current_hashes:
                return candidate
        except Exception as exc:
            errors.append({"source": source, "error": str(exc)})
    if candidates:
        return {
            "source": "no_alternate_official",
            "errors": errors,
            "candidates": [
                {key: item[key] for key in ("source", "audioUrl", "matchesCurrent")}
                for item in candidates
            ],
        }
    return {"source": "no_official_audio", "errors": errors}


def update_audio(feedback_rows, wordlist_changes=None, apply=False):
    entries_by_id = {}
    ids_by_term = {}
    for line in WORDLIST.read_text(encoding="utf-8").splitlines():
        entry = parse_line(line)
        if not entry:
            continue
        entries_by_id[entry["word_id"]] = entry
        ids_by_term.setdefault(entry["term"].strip().lower(), set()).add(entry["word_id"])
    changed_pronunciations = {
        change["wordId"]: change["pronunciationQuery"]
        for change in (wordlist_changes or [])
        if change.get("pronunciationQuery")
    }
    changes = []
    for row in feedback_rows:
        issue_types = set((row["issue_types"] or "").split(","))
        if "pronunciation" not in issue_types and row["word_id"] not in changed_pronunciations:
            continue
        query = changed_pronunciations.get(row["word_id"]) or row["pronunciation_query"].strip() or row["suggested_term"].strip() or row["term"].strip()
        if not query:
            changes.append({"id": row["id"], "wordId": row["word_id"], "action": "missing-pronunciation-query"})
            continue
        target_ids = {row["word_id"]}
        target_ids.update(ids_by_term.get(query.strip().lower(), set()))
        target_ids.update(ids_by_term.get(str(row.get("term", "")).strip().lower(), set()))
        target_ids.update(ids_by_term.get(str(row.get("suggested_term", "")).strip().lower(), set()))
        changes.append({
            "id": row["id"],
            "wordId": row["word_id"],
            "targetWordIds": sorted(target_ids),
            "action": "replace-audio",
            "query": query,
        })
        if apply:
            if "pronunciation" in issue_types:
                official = find_alternate_official_audio(query, target_ids)
                if official and official.get("data"):
                    data = official["data"]
                    changes[-1]["source"] = official["source"]
                    changes[-1]["audioUrl"] = official["audioUrl"]
                    changes[-1]["policy"] = "alternate-official"
                else:
                    changes[-1]["source"] = official.get("source", "no_official_audio") if official else "no_official_audio"
                    changes[-1]["error"] = "No different official audio source was found"
                    if official:
                        changes[-1]["details"] = {
                            key: official[key]
                            for key in ("errors", "candidates")
                            if key in official
                        }
                    continue
            elif (official := find_official_audio(query)) and official.get("source") != "tts_fallback" and official.get("data"):
                data = official["data"]
                changes[-1]["source"] = official["source"]
                changes[-1]["audioUrl"] = official["audioUrl"]
            else:
                data, error = fetch_audio(query)
                changes[-1]["source"] = "tts_fallback"
                if error:
                    changes[-1]["error"] = error
                    continue
            for word_id in target_ids:
                (AUDIO_DIR / f"{word_id}.mp3").write_bytes(data)
    return changes


def mark_resolved(feedback_rows):
    if not feedback_rows:
        return
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
    audio_changes = update_audio(feedback_rows, wordlist_changes=wordlist_changes, apply=args.apply)
    failed_ids = {
        change["id"]
        for change in [*wordlist_changes, *audio_changes]
        if change.get("error") or str(change.get("action", "")).startswith("missing")
    }
    resolved_rows = [row for row in feedback_rows if row["id"] not in failed_ids]
    if args.apply and feedback_rows:
        mark_resolved(resolved_rows)
    print(json.dumps({
        "mode": "apply" if args.apply else "preview",
        "feedbackCount": len(feedback_rows),
        "resolvedCount": len(resolved_rows) if args.apply else 0,
        "failedCount": len(failed_ids),
        "wordlistChanges": wordlist_changes,
        "audioChanges": audio_changes,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
