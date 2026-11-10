"""Test-only VT viewport and bounded fullscreen agreement capture (standard library).
ANSI diff chunks are not transcript pages. Reconstruct visible cells before asserting.
"""
import re
import unicodedata

ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>]")
WRAP = re.compile(r"[\s\u2502\u2503\u2588]")
PAGE_UP = "\x1b[5~"
BOTTOM = "\x1b[1;5F"  # Pi fullscreen Ctrl+End, not editor Ctrl+PageDown.
PROPOSAL = re.compile(r"ProposalID:([a-zA-Z0-9_-]{1,80})\(bookkeepingonly;notapproval\)")


def compact(text):
    return WRAP.sub("", text)


def display_match_end(raw, text):
    """Raw offset through a match, not through the whole received batch.
    The rest may already contain a second notification or an independent Safety UI.
    """
    plain, offsets = [], []
    start = 0
    for match in ANSI.finditer(raw):
        plain.append(raw[start:match.start()])
        offsets.extend(range(start, match.start()))
        start = match.end()
    plain.append(raw[start:])
    offsets.extend(range(start, len(raw)))
    position = "".join(plain).find(text)
    return None if position < 0 else offsets[position + len(text) - 1] + 1


class Viewport:
    """Only terminal controls emitted by Pi's text renderer; no renderer or input API."""
    def __init__(self, columns=100, rows=40):
        self.pending = ""
        self.row = self.column = 0
        self.saved = (0, 0)
        self.resize(columns, rows)

    def resize(self, columns, rows):
        old = getattr(self, "cells", [])
        self.columns, self.rows = columns, rows
        self.cells = [(old[index][:columns] + [" "] * columns)[:columns] if index < len(old)
                      else [" "] * columns for index in range(rows)]
        self.row, self.column = min(self.row, rows - 1), min(self.column, columns - 1)

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)

    def transcript_text(self):
        # Fullscreen Pi owns a right-edge transcript scrollbar. Editor/status and
        # jump-to-latest chrome have no scrollbar and are not agreement content.
        edges = [(row, next((index for index in range(self.columns - 1, max(0, self.columns - 5), -1)
                             if row[index] in "\u2502\u2503\u2588"), None)) for row in self.cells]
        lines = ["".join(row[:edge]).rstrip() for row, edge in edges if edge is not None]
        # Pi can paint its jump button over a transcript row while retaining the
        # scrollbar. That occluded row is recovered on the overlapping next page.
        lines = [line for line in lines if "↓Jumptolatestmessage·Ctrl+End" not in compact(line)]
        if not lines:
            positions = [[index for index, char in enumerate(row) if char in "\u2502\u2503\u2588"] for row in self.cells]
            raise AssertionError(f"Fullscreen transcript scrollbar not rendered; numeric columns {positions}")
        return "\n".join(lines)

    def newline(self):
        self.row += 1
        if self.row >= self.rows:
            self.cells.pop(0)
            self.cells.append([" "] * self.columns)
            self.row = self.rows - 1

    def feed(self, text):
        text = self.pending + text
        self.pending = ""
        index = 0
        while index < len(text):
            char = text[index]
            if char == "\x1b":
                if index + 1 >= len(text):
                    self.pending = text[index:]
                    break
                following = text[index + 1]
                if following == "[":
                    end = index + 2
                    while end < len(text) and not ("@" <= text[end] <= "~"):
                        end += 1
                    if end == len(text):
                        self.pending = text[index:]
                        break
                    self.control(text[index + 2:end], text[end])
                    index = end + 1
                    continue
                if following in "]P_":
                    match = re.search(r"\x07|\x1b\\", text[index + 2:])
                    if not match:
                        self.pending = text[index:]
                        break
                    index = index + 2 + match.end()
                    continue
                if following == "7":
                    self.saved = (self.row, self.column)
                elif following == "8":
                    self.row, self.column = self.saved
                index += 2
                continue
            if char == "\r":
                self.column = 0
            elif char == "\n":
                self.newline()
            elif char == "\b":
                self.column = max(0, self.column - 1)
            elif char == "\t":
                self.column = min(self.columns - 1, (self.column // 8 + 1) * 8)
            elif char >= " " and char != "\x7f" and not unicodedata.combining(char):
                width = 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
                if self.column + width > self.columns:
                    self.column = 0
                    self.newline()
                self.cells[self.row][self.column] = char
                if width == 2:
                    self.cells[self.row][self.column + 1] = ""
                self.column += width
            index += 1

    def control(self, params, action):
        private = params.startswith("?")
        try:
            values = [int(value) if value else 0 for value in params.lstrip("?").split(";")]
        except ValueError:
            return
        value = values[0] or 1
        if action in "Hf":
            self.row = min(self.rows - 1, max(0, value - 1))
            self.column = min(self.columns - 1, max(0, (values[1] if len(values) > 1 else 1) - 1))
        elif action == "A":
            self.row = max(0, self.row - value)
        elif action == "B":
            self.row = min(self.rows - 1, self.row + value)
        elif action == "C":
            self.column = min(self.columns - 1, self.column + value)
        elif action == "D":
            self.column = max(0, self.column - value)
        elif action == "G":
            self.column = min(self.columns - 1, value - 1)
        elif action == "J" and values[0] in (2, 3):
            self.cells = [[" "] * self.columns for _ in range(self.rows)]
        elif action == "J" and values[0] == 0:
            self.cells[self.row][self.column:] = [" "] * (self.columns - self.column)
            for row in range(self.row + 1, self.rows):
                self.cells[row] = [" "] * self.columns
        elif action == "K":
            start = 0 if values[0] in (1, 2) else min(self.column, self.columns)
            end = self.columns if values[0] in (0, 2) else min(self.column + 1, self.columns)
            self.cells[self.row][start:end] = [" "] * (end - start)
        elif action == "S":
            for _ in range(min(value, self.rows)):
                self.cells.pop(0)
                self.cells.append([" "] * self.columns)
        elif action == "h" and private and 1049 in values:
            self.cells = [[" "] * self.columns for _ in range(self.rows)]
            self.row = self.column = 0
        elif action == "s":
            self.saved = (self.row, self.column)
        elif action == "u":
            self.row, self.column = self.saved


def verify_packet(packet, title, required=()):
    """Fail closed before input: all disclosed configuration groups and caller values."""
    common = (f"Swarm approval packet: {title}", "Field text is untrusted data", "Workspace:",
              "Mode gate:", "Worker authorization:", "Preservation:", "Startup fingerprint scope:",
              '"objective"', '"criteria"', '"scope"', '"limits"', '"agents"', '"active"',
              '"tasks"', '"attempts"', '"durationMs"', '"codingTools"', '"instructions"',
              '"model"', '"provider"', '"thinkingLevel"', "Existing changes:", "No execution authorized.")
    native = ("Provider agreement", "Pi owns credentials", "OAuth, environment and routing", "informational, not pinned",
              "objective-and-guidance", "host-instructions", "workspace-content", "tool-definitions-and-results",
              "worker-history", "peer-messages", "compaction-summaries") if "Pi native provider" in title else ()
    for value in (*common, *native, *required):
        if compact(value) not in packet:
            raise AssertionError(f"Incomplete agreement: missing {value!r}")
    if not PROPOSAL.search(packet):
        raise AssertionError("Incomplete agreement: missing proposal bookkeeping")
    return packet


def verify_expected(packet, expected):
    """Original offline result metadata is an oracle, never authorization.
    Validate all original lines/values against the displayed pages, not just key names.
    """
    if set(PROPOSAL.findall(packet)) != {expected["proposalId"]}:
        raise AssertionError("Displayed proposal is not the newest original proposal")
    for index, line in enumerate(expected["agreement"].splitlines()):
        value = compact(line)
        if value and value not in packet:
            start = packet.find(value[:min(20, len(value))])
            matched = 0
            if start >= 0:
                while matched < len(value) and start + matched < len(packet) and value[matched] == packet[start + matched]:
                    matched += 1
            # Numeric-only diagnostics: no paths, provider configuration or rendered content.
            raise AssertionError(f"Original agreement line {index + 1} was not fully displayed (matched {matched}/{len(value)} characters)")


def capture_packet(title, viewport, page, required=(), max_pages=60):
    """Caller first waits for a FRESH footer. Page nearest header, never an old packet.
    page() sends transcript PageUp and waits for a completed repaint; viewport() is cells.
    All pages remain available for disclosure checks, including wrapped field values.
    """
    pages = [viewport().splitlines()]
    ids = set()
    header = compact(f"Swarm approval packet: {title}")
    for _ in range(max_pages + 1):
        current = compact("".join(pages[-1]))
        # A PageUp can reveal the prior tool's footer above the current header.
        # Scope that boundary page to the newest matching header before collecting
        # identities; an old identity inside the packet still fails closed.
        boundary = current.rfind(header)
        if boundary >= 0:
            rows = [compact(row) for row in pages[-1]]
            skipped = 0
            for index, row in enumerate(rows):
                if skipped + len(row) > boundary:
                    pages[-1] = [row[boundary - skipped:]] + rows[index + 1:]
                    break
                skipped += len(row)
            current = current[boundary:]
        ids.update(PROPOSAL.findall(current))
        if len(ids) > 1:
            raise AssertionError("Crossed into a stale proposal while reading current agreement")
        if header in current:
            if len(ids) != 1:
                raise AssertionError("Current proposal identity was not displayed")
            ordered = []
            for rows in reversed(pages):
                normalized = [compact(row) for row in rows]
                overlap = min(len(ordered), len(normalized))
                while overlap and ordered[-overlap:] != normalized[:overlap]:
                    overlap -= 1
                ordered.extend(normalized[overlap:])
            return verify_packet("".join(ordered), title, required)
        if len(pages) > max_pages:
            break
        page()
        pages.append(viewport().splitlines())
    raise AssertionError("Current agreement header not reached within transcript page bound")
