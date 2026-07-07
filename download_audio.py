from __future__ import annotations

import concurrent.futures
import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORDLIST = ROOT / "wordlist.txt"
AUDIO_DIR = ROOT / "audio"
MANIFEST = ROOT / "audio-manifest.json"
AUDIO_DIR.mkdir(exist_ok=True)


def read_entries():
    entries = []
    pattern = re.compile(r"^P(\d+)\s+(\d+)\s+(.+)$")
    for line in WORDLIST.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if not match:
            continue
        parts = [part.strip() for part in re.split(r"\s{2,}", match.group(3).strip()) if part.strip()]
        if not parts:
            continue
        entries.append((f"P{match.group(1)}-{match.group(2)}", parts[0]))
    return entries


def fetch_audio(term: str):
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
    last_error = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = response.read()
            if len(data) < 500:
                raise ValueError(f"Audio response too small: {len(data)} bytes")
            return data, None
        except Exception as exc:
            last_error = str(exc)
            time.sleep(1.5 * (attempt + 1))
    return None, last_error


def main():
    entries = read_entries()
    grouped = defaultdict(list)
    for word_id, term in entries:
        grouped[term.lower()].append((word_id, term))

    pending = []
    for key, targets in grouped.items():
        if not all((AUDIO_DIR / f"{word_id}.mp3").exists() for word_id, _ in targets):
            pending.append((key, targets))

    print(f"Entries: {len(entries)}, unique pronunciations: {len(grouped)}, pending: {len(pending)}", flush=True)
    failures = {}
    completed = 0

    def download(item):
        key, targets = item
        data, error = fetch_audio(targets[0][1])
        if data:
            for word_id, _ in targets:
                (AUDIO_DIR / f"{word_id}.mp3").write_bytes(data)
        return key, targets, error

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(download, item) for item in pending]
        for future in concurrent.futures.as_completed(futures):
            key, targets, error = future.result()
            completed += 1
            if error:
                failures[key] = {"term": targets[0][1], "error": error}
            if completed % 50 == 0 or completed == len(pending):
                print(f"Progress: {completed}/{len(pending)}, failures: {len(failures)}", flush=True)

    available = [word_id for word_id, _ in entries if (AUDIO_DIR / f"{word_id}.mp3").exists()]
    manifest = {
        "totalEntries": len(entries),
        "available": len(available),
        "missing": len(entries) - len(available),
        "failures": failures,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
