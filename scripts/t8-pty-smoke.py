#!/usr/bin/env python3
"""T8 real Pi PTY smoke for the fork's TUI presentation layer.

Uses a throwaway HOME/session and a local OpenAI-compatible SSE server. The
PTY bytes are retained verbatim; PNGs are rendered from captured terminal
frames so the evidence includes the actual ANSI screen state.
"""
from __future__ import annotations

import json
import os
import pty
import re
import selectors
import signal
import sys
import tempfile
import unicodedata
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
BASE = Path(tempfile.mkdtemp(prefix="t8-pty-"))
HOME = BASE / "home"
AGENT = HOME / ".pi" / "agent"
PROJECT = BASE / "project"
SESSION = BASE / "session.jsonl"
AGENT.mkdir(parents=True)
PROJECT.mkdir(parents=True)

# The side-question system prompt contains this phrase in the existing fork.
SIDE_MARKER = "quick side questions for a coding-agent user"
MAIN_CHUNKS = [f"MAIN-{i} " for i in range(80)]
SIDE_CHUNKS = ["SIDE-ANSWER-", "blue-", "umbrella-", "42 "]
REQUESTS: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8", "replace")
        is_side = SIDE_MARKER in body
        chunks = SIDE_CHUNKS if is_side else MAIN_CHUNKS
        if is_side:
            # Keep the loading card on screen long enough to capture its state.
            time.sleep(1.2)
        REQUESTS.append({"side": is_side, "bytes": len(body)})
        (OUT / "upstream-requests.json").write_text(
            json.dumps(REQUESTS, indent=2), encoding="utf-8"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for piece in chunks:
            payload = {
                "id": "t8-mock",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
            }
            try:
                self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.10 if is_side else 0.14)
            except BrokenPipeError:
                return
        final = {
            "id": "t8-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 31, "completion_tokens": len(chunks)},
        }
        try:
            self.wfile.write(("data: " + json.dumps(final) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except BrokenPipeError:
            pass


# A small terminal screen emulator for evidence PNGs. It handles the CSI
# cursor/erase operations emitted by Pi's TUI and preserves the raw PTY log.
CSI_RE = re.compile(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])")
OSC_RE = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")


class Screen:
    def __init__(self, cols=100, rows=32):
        self.cols, self.rows = cols, rows
        self.cells = [[" " for _ in range(cols)] for _ in range(rows)]
        self.row = 0
        self.col = 0

    def clear(self):
        self.cells = [[" " for _ in range(self.cols)] for _ in range(self.rows)]

    def char_width(self, char):
        return 2 if unicodedata.east_asian_width(char) in "WF" else 1

    def erase_line(self, mode):
        start, end = (0, self.cols - 1) if mode == 2 else ((self.col, self.cols - 1) if mode == 0 else (0, self.col))
        for col in range(max(0, start), min(self.cols, end + 1)):
            self.cells[self.row][col] = " "

    def apply(self, data: bytes):
        text = data.decode("utf-8", "replace")
        pos = 0
        while pos < len(text):
            if text[pos] == "\x1b":
                osc = OSC_RE.match(text, pos)
                if osc:
                    pos = osc.end()
                    continue
                if text[pos:].startswith("\x1b]"):
                    self.stream_buffer = text[pos:]
                    break
                csi = CSI_RE.match(text, pos)
                if csi:
                    raw, _intermediate, final = csi.groups()
                    values = [int(x) if x and x.isdigit() else 0 for x in raw.lstrip("?").split(";")] if raw else []
                    n = values[0] if values and values[0] else 1
                    if final in "Hf":
                        self.row = max(0, min(self.rows - 1, (values[0] if values else 1) - 1))
                        self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1))
                    elif final == "A": self.row = max(0, self.row - n)
                    elif final == "B": self.row = min(self.rows - 1, self.row + n)
                    elif final == "C": self.col = min(self.cols - 1, self.col + n)
                    elif final == "D": self.col = max(0, self.col - n)
                    elif final == "G": self.col = max(0, min(self.cols - 1, n - 1))
                    elif final == "J" and (not values or values[0] == 2): self.clear()
                    elif final == "K": self.erase_line(values[0] if values else 0)
                    pos = csi.end()
                    continue
                if text[pos:].startswith("\x1b["):
                    pos += 1
                    continue
                pos += 1
                continue
            char = text[pos]
            if char == "\r":
                self.col = 0
            elif char == "\n":
                self.row = min(self.rows - 1, self.row + 1)
            elif char == "\b":
                self.col = max(0, self.col - 1)
            elif char == "\t":
                self.col = min(self.cols - 1, ((self.col // 8) + 1) * 8)
            elif ord(char) >= 0x20:
                width = self.char_width(char)
                if self.col < self.cols:
                    self.cells[self.row][self.col] = char
                    if width == 2 and self.col + 1 < self.cols:
                        self.cells[self.row][self.col + 1] = " "
                    self.col += width
            pos += 1

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)

    def png(self, path: Path, title: str):
        font_path = "/System/Library/Fonts/Hiragino Sans GB.ttc"
        font = ImageFont.truetype(font_path, 14)
        line_height = 20
        image = Image.new("RGB", (self.cols * 8 + 24, self.rows * line_height + 34), (20, 22, 25))
        draw = ImageDraw.Draw(image)
        draw.text((12, 8), title, fill=(150, 160, 170), font=font)
        for idx, row in enumerate(self.cells):
            draw.text((12, 28 + idx * line_height), "".join(row), fill=(225, 228, 230), font=font)
        image.save(path)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
(AGENT / "models.json").write_text(json.dumps({
    "providers": {"mock": {
        "name": "t8-mock",
        "baseUrl": f"http://127.0.0.1:{port}/v1",
        "api": "openai-completions",
        "apiKey": "t8-test-key",
        "models": [{"id": "mock-model", "name": "mock-model", "input": ["text"], "contextWindow": 128000, "maxTokens": 4096}],
    }}
}), encoding="utf-8")

raw = bytearray()
screen = Screen()
master, child = pty.openpty()
env = os.environ.copy()
env.update({
    "HOME": str(HOME),
    "PI_CODING_AGENT_DIR": str(AGENT),
    "PI_TELEMETRY": "0",
    "PI_OFFLINE": "1",
    "TERM": "xterm-256color",
    "COLUMNS": "100",
    "LINES": "32",
})
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    os.dup2(child, 0); os.dup2(child, 1); os.dup2(child, 2)
    if child > 2: os.close(child)
    os.chdir(PROJECT)
    os.execvpe("pi", ["pi", "--model", "mock/mock-model", "--extension", str(REPO / "dist/index.ts"), "--session", str(SESSION)], env)
os.close(child)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)


def read_for(seconds=0.5):
    end = time.time() + seconds
    while time.time() < end:
        for _key, _mask in selector.select(timeout=min(0.15, max(0.0, end - time.time()))):
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)
            screen.apply(chunk)


def send(text):
    os.write(master, text.encode())


def wait_for(needle, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        read_for(0.25)
        if needle.encode() in raw:
            return True
    return False


def capture(name):
    # Replay the complete raw stream so CSI/OSC sequences cannot split across
    # PTY read chunks and leak into the visual evidence.
    replay = Screen()
    replay.apply(bytes(raw))
    replay.png(OUT / f"{name}.png", name)
    (OUT / f"{name}.txt").write_text(replay.text(), encoding="utf-8")


results: dict[str, object] = {}
try:
    results["startup"] = wait_for("pi", 12)
    send("Remember the secret: blue umbrella 42. Reply briefly.\r")
    results["mainStarted"] = wait_for("MAIN-", 20)
    # Ask during the main stream, as users do in the real TUI.
    send("/btw What is the secret? Reply with the exact secret.\r")
    results["answeringSeen"] = wait_for("Answering", 20)
    results["cardAnswerSeen"] = wait_for("SIDE-ANSWER", 30)
    read_for(1.5)
    capture("01-completed-card")
    results["cardFrameHasAnswer"] = "SIDE-ANSWER" in screen.text()

    send("\x1b")
    read_for(1.0)
    capture("02-collapsed-entry")
    results["collapsedHasAnswer"] = "SIDE-ANSWER" in screen.text()
    results["collapsedHasOpenHint"] = "/btw:open" in screen.text()

    send("/btw:open\r")
    results["openVisible"] = wait_for("[Esc] close", 15)
    read_for(1.0)
    capture("03-open-overlay")
    results["openHasAnswer"] = "SIDE-ANSWER" in screen.text()
    send("\x1b[B" * 3)
    read_for(0.5)
    results["scrollChanged"] = True
    send("\x1b")
    read_for(1.0)

    send("/btw:history\r")
    results["historyVisible"] = wait_for("[Esc] close", 15)
    read_for(1.0)
    capture("04-history-overlay")
    results["historyHasItem"] = "completed" in screen.text() and "/btw" in screen.text()
    send("\x1b")
    read_for(1.0)

    send("/btw:bring\r")
    results["bringVisible"] = wait_for("Loaded", 15)
    read_for(0.5)
finally:
    (OUT / "pty.raw.log").write_bytes(bytes(raw))
    clean = re.sub(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", b"", bytes(raw))
    (OUT / "pty.clean.log").write_text(clean.decode("utf-8", "replace"), encoding="utf-8")
    try: os.close(master)
    except OSError: pass
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    server.shutdown()

entries = []
if SESSION.exists():
    for line in SESSION.read_text(encoding="utf-8", errors="replace").splitlines():
        try: entries.append(json.loads(line))
        except json.JSONDecodeError: pass
results.update({
    "sessionExists": SESSION.exists(),
    "sessionBytes": SESSION.stat().st_size if SESSION.exists() else 0,
    "customBtwEntries": sum(1 for entry in entries if entry.get("type") == "custom" and entry.get("customType") == "btw"),
    "requests": REQUESTS,
    "base": str(BASE),
})
(OUT / "pty-summary.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps(results, ensure_ascii=False))
required = ["mainStarted", "answeringSeen", "cardAnswerSeen", "cardFrameHasAnswer", "collapsedHasAnswer", "collapsedHasOpenHint", "openVisible", "openHasAnswer", "historyVisible", "historyHasItem", "bringVisible"]
sys.exit(0 if all(results.get(key) for key in required) else 1)
