#!/usr/bin/env python3
"""Collect public circle/class descriptions from the Shikosai site.

Only HTML text and image URL paths are saved. This script never downloads
images, video, or other media files.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


BASE_URL = "https://34.shikosai.net"
USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0"


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_main = False
        self.drop_depth = 0
        self.tag_stack: list[str] = []
        self.current_heading: list[str] | None = None
        self.current_paragraph: list[str] | None = None
        self.headings: list[str] = []
        self.paragraphs: list[str] = []
        self.main_text: list[str] = []
        self.images: list[dict[str, str]] = []
        self.document_title: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "main":
            self.in_main = True
        if tag in {"script", "style", "svg", "nav", "footer", "noscript"}:
            self.drop_depth += 1
        if not self.in_main or self.drop_depth:
            return
        if tag in {"h1", "h2", "h3"}:
            self.current_heading = []
        if tag == "p":
            self.current_paragraph = []
        if tag == "img":
            src = attrs_map.get("src") or attrs_map.get("data-src") or ""
            self.images.append({"path": urljoin(BASE_URL, src), "alt": attrs_map.get("alt") or ""})

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag == "main":
            self.in_main = False
        if tag in {"script", "style", "svg", "nav", "footer", "noscript"} and self.drop_depth:
            self.drop_depth -= 1
        if tag in {"h1", "h2", "h3"} and self.current_heading is not None:
            value = clean("".join(self.current_heading))
            if value:
                self.headings.append(value)
            self.current_heading = None
        if tag == "p" and self.current_paragraph is not None:
            value = clean("".join(self.current_paragraph))
            if value:
                self.paragraphs.append(value)
            self.current_paragraph = None

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.document_title.append(data)
        if not self.in_main or self.drop_depth:
            return
        value = clean(data)
        if not value:
            return
        self.main_text.append(value)
        if self.current_heading is not None:
            self.current_heading.append(data)
        if self.current_paragraph is not None:
            self.current_paragraph.append(data)


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def fetch_html(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=25) as response:
        return response.read().decode("utf-8", "replace")


def extract_circle_urls(index_html: str) -> list[str]:
    class LinkParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.urls: set[str] = set()

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            if tag != "a":
                return
            href = dict(attrs).get("href") or ""
            parsed = urlparse(urljoin(BASE_URL, href))
            if parsed.netloc == urlparse(BASE_URL).netloc:
                path = parsed.path.rstrip("/")
                if path.startswith("/circle/") and path != "/circle":
                    self.urls.add(path)

    parser = LinkParser()
    parser.feed(index_html)
    return sorted(parser.urls)


def extract_record(path: str) -> dict[str, object]:
    parser = PageParser()
    parser.feed(fetch_html(urljoin(BASE_URL, path)))
    slug = path.rsplit("/", 1)[-1]
    title = parser.headings[0] if parser.headings else clean("".join(parser.document_title)).split("|")[0].strip()

    detail_start = next((i for i, text in enumerate(parser.main_text) if text == "価格・企画内容"), None)
    detail_end = next((i for i, text in enumerate(parser.main_text) if text == "SNS・公式サイト"), None)
    detail_description = ""
    if detail_start is not None:
        end = detail_end if detail_end is not None and detail_end > detail_start else len(parser.main_text)
        detail_description = " ".join(parser.main_text[detail_start + 1 : end])

    intro = parser.paragraphs[0] if parser.paragraphs else ""
    group_label = next((text for text in parser.main_text if re.fullmatch(r"\d+年生", text)), "")
    kind = "class" if re.fullmatch(r"\d+-\d+|\d+[A-Za-z]\d?", slug) else "circle"
    image = parser.images[0] if parser.images else {"path": "", "alt": ""}

    return {
        "slug": slug,
        "name": title,
        "kind": kind,
        "class_name": slug if kind == "class" else "",
        "group_name": group_label,
        "description": intro,
        "program_description": detail_description,
        "circle_cut_path": image["path"],
        "circle_cut_alt": image["alt"],
        "source_url": urljoin(BASE_URL, path),
    }


def main() -> None:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--output", default="seed/shikosai-catalog.json")
    argument_parser.add_argument("--delay", type=float, default=0.15)
    args = argument_parser.parse_args()

    paths = extract_circle_urls(fetch_html(urljoin(BASE_URL, "/circle/")))
    records = []
    for index, path in enumerate(paths):
        records.append(extract_record(path))
        if index + 1 < len(paths):
            time.sleep(max(0.0, args.delay))

    timestamp = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
    payload = {
        "source": BASE_URL + "/circle/",
        "scraped_at": timestamp,
        "media_policy": "URLs and local paths only; no media files downloaded or uploaded.",
        "records": records,
    }

    from pathlib import Path

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {len(records)} public records to {output}")
    print(f"Classes: {sum(item['kind'] == 'class' for item in records)}, circles: {sum(item['kind'] == 'circle' for item in records)}")


if __name__ == "__main__":
    main()
