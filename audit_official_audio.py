from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORDLIST = ROOT / "wordlist.txt"
AUDIO_DIR = ROOT / "audio"
REPORT = ROOT / "official-audio-report.json"
OFFICIAL_DIR = ROOT / "official_audio_cache"
MISS_CACHE = ROOT / "official-audio-missing.json"
OVERRIDES = ROOT / "audio-overrides.json"
OFFICIAL_DIR.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}


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
        entries.append({"id": f"P{match.group(1)}-{match.group(2)}", "term": parts[0]})
    return entries


def slug(term: str):
    value = term.lower().strip()
    value = value.replace("&", " and ")
    value = re.sub(r"[’']", "", value)
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def request_text(url: str, timeout=8):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def request_audio(url: str, timeout=10):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        content_type = response.headers.get("Content-Type", "")
    if len(data) < 500 or "audio" not in content_type.lower():
        raise ValueError(f"bad audio response: {len(data)} bytes, {content_type}")
    return data


def load_audio_overrides():
    if not OVERRIDES.exists():
        return {}
    try:
        return json.loads(OVERRIDES.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def first_oxford_uk_audio(term: str):
    page = f"https://www.oxfordlearnersdictionaries.com/definition/english/{slug(term)}"
    html = request_text(page)
    match = re.search(r'class="[^"]*pron-uk[^"]*"[^>]*data-src-mp3="([^"]+)"', html)
    if not match:
        return None
    return match.group(1).replace("&amp;", "&"), page


def first_cambridge_uk_audio(term: str):
    page = f"https://dictionary.cambridge.org/dictionary/english/{slug(term)}"
    html = request_text(page)
    uk_index = html.find('class="uk dpron-i')
    if uk_index < 0:
        uk_index = html.find('class="region dreg">uk')
    if uk_index < 0:
        return None
    snippet = html[uk_index:uk_index + 3000]
    match = re.search(r'<source[^>]+type="audio/mpeg"[^>]+src="([^"]+)"', snippet)
    if not match:
        return None
    audio_url = urllib.parse.urljoin("https://dictionary.cambridge.org", match.group(1))
    return audio_url, page


def find_official_audio(term: str):
    override = load_audio_overrides().get(term.strip().lower())
    if override and override.get("audioUrl"):
        data = request_audio(override["audioUrl"])
        return {
            "source": override.get("source", "override"),
            "pageUrl": override.get("pageUrl", ""),
            "audioUrl": override["audioUrl"],
            "data": data,
            "override": True,
        }
    errors = []
    for source, finder in (("oxford", first_oxford_uk_audio), ("cambridge", first_cambridge_uk_audio)):
        try:
            found = finder(term)
            if found:
                audio_url, page_url = found
                data = request_audio(audio_url)
                return {"source": source, "pageUrl": page_url, "audioUrl": audio_url, "data": data}
        except Exception as exc:
            errors.append({"source": source, "error": str(exc)})
    return {"source": "tts_fallback", "errors": errors}


def audit_entry(entry, apply=False):
    word_id = entry["id"]
    term = entry["term"]
    cache_file = OFFICIAL_DIR / f"{word_id}.mp3"
    if cache_file.exists():
        if apply:
            (AUDIO_DIR / f"{word_id}.mp3").write_bytes(cache_file.read_bytes())
        return {"id": word_id, "term": term, "status": "official_cached", "source": "cache"}

    result = find_official_audio(term)
    if result["source"] == "tts_fallback":
        return {"id": word_id, "term": term, "status": "tts_fallback", "errors": result.get("errors", [])}

    if apply:
        cache_file.write_bytes(result["data"])
        (AUDIO_DIR / f"{word_id}.mp3").write_bytes(result["data"])
    return {
        "id": word_id,
        "term": term,
        "status": "official",
        "source": result["source"],
        "pageUrl": result["pageUrl"],
        "audioUrl": result["audioUrl"],
        "bytes": len(result["data"]),
    }


def main():
    parser = argparse.ArgumentParser(description="Audit local pronunciation files against official UK dictionary audio.")
    parser.add_argument("--apply", action="store_true", help="Replace local audio when official UK audio is found.")
    parser.add_argument("--limit", type=int, default=0, help="Only process the first N entries.")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--start", type=int, default=0, help="Skip the first N entries before processing.")
    parser.add_argument("--retry-missing", action="store_true", help="Retry entries previously recorded as missing.")
    args = parser.parse_args()

    entries = read_entries()
    missing_cache = {}
    if MISS_CACHE.exists() and not args.retry_missing:
        try:
            missing_cache = json.loads(MISS_CACHE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            missing_cache = {}
    if args.start:
        entries = entries[args.start:]
    if args.limit:
        entries = entries[:args.limit]
    entries = [
        entry for entry in entries
        if (OFFICIAL_DIR / f"{entry['id']}.mp3").exists() or entry["id"] not in missing_cache
    ]

    results = []
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(audit_entry, entry, args.apply) for entry in entries]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            results.append(future.result())
            if index % 25 == 0 or index == len(futures):
                official = sum(1 for item in results if item["status"].startswith("official"))
                print(f"Progress {index}/{len(futures)} official={official}", flush=True)

    summary = {
        "mode": "apply" if args.apply else "preview",
        "total": len(entries),
        "official": sum(1 for item in results if item["status"].startswith("official")),
        "ttsFallback": sum(1 for item in results if item["status"] == "tts_fallback"),
        "elapsedSeconds": round(time.time() - started, 1),
        "results": sorted(results, key=lambda item: item["id"]),
    }
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in results:
        if item["status"] == "tts_fallback":
            missing_cache[item["id"]] = item
    MISS_CACHE.write_text(json.dumps(missing_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("mode", "total", "official", "ttsFallback", "elapsedSeconds")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
