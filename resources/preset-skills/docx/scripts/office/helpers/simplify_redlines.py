"""Collapse consecutive tracked-change wrappers from the same reviewer.

Adjacent ``<w:ins>`` blocks by the same author are folded into one element;
likewise for ``<w:del>``.  This dramatically reduces clutter in documents
with heavy revision history.

Constraints:
  * Only same-type merges: ``ins`` with ``ins``, ``del`` with ``del``.
  * Author must match (timestamps are ignored).
  * Elements must be truly adjacent — only insignificant whitespace allowed
    between them.
"""

import pathlib
import xml.etree.ElementTree as ET
import zipfile

import defusedxml.minidom

_WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


# ── DOM helpers (minidom) ────────────────────────────────────────────────────

def _scan_elements(root, tag: str) -> list:
    found: list = []
    def _recurse(nd):
        if nd.nodeType == nd.ELEMENT_NODE:
            lname = nd.localName or nd.tagName
            if lname == tag or lname.endswith(":%s" % tag):
                found.append(nd)
            for ch in nd.childNodes:
                _recurse(ch)
    _recurse(root)
    return found


def _tag_match(nd, tag: str) -> bool:
    lname = nd.localName or nd.tagName
    return lname == tag or lname.endswith(":%s" % tag)


def _extract_author(elem) -> str:
    val = elem.getAttribute("w:author")
    if val:
        return val
    for attr in elem.attributes.values():
        if attr.localName == "author" or attr.name.endswith(":author"):
            return attr.value
    return ""


def _only_whitespace_between(first, second) -> bool:
    cur = first.nextSibling
    while cur is not None and cur is not second:
        if cur.nodeType == cur.ELEMENT_NODE:
            return False
        if cur.nodeType == cur.TEXT_NODE and cur.data.strip():
            return False
        cur = cur.nextSibling
    return True


def _transplant_children(dest, src) -> None:
    while src.firstChild:
        node = src.firstChild
        src.removeChild(node)
        dest.appendChild(node)


def _fold_tracked_in(container, tag: str) -> int:
    candidates = [
        ch for ch in container.childNodes
        if ch.nodeType == ch.ELEMENT_NODE and _tag_match(ch, tag)
    ]
    if len(candidates) < 2:
        return 0

    count = 0
    pos = 0
    while pos < len(candidates) - 1:
        left, right = candidates[pos], candidates[pos + 1]
        if _extract_author(left) == _extract_author(right) and _only_whitespace_between(left, right):
            _transplant_children(left, right)
            container.removeChild(right)
            candidates.pop(pos + 1)
            count += 1
        else:
            pos += 1
    return count


# ── Public API (minidom-based) ───────────────────────────────────────────────

def simplify_redlines(input_dir: str) -> tuple[int, str]:
    """Merge adjacent same-author tracked changes in ``document.xml``."""
    doc_path = pathlib.Path(input_dir) / "word" / "document.xml"
    if not doc_path.exists():
        return 0, "Error: %s not found" % doc_path

    try:
        dom = defusedxml.minidom.parseString(doc_path.read_text(encoding="utf-8"))
        top = dom.documentElement

        buckets = _scan_elements(top, "p") + _scan_elements(top, "tc")
        total = 0
        for bkt in buckets:
            total += _fold_tracked_in(bkt, "ins")
            total += _fold_tracked_in(bkt, "del")

        dom_bytes = dom.toxml(encoding="UTF-8")
        doc_path.write_bytes(dom_bytes)
        return total, "Simplified %d tracked changes" % total
    except Exception as exc:
        return 0, "Error: %s" % exc


# ── ElementTree-based author analysis ────────────────────────────────────────

def get_tracked_change_authors(doc_xml_path: pathlib.Path) -> dict[str, int]:
    """Return ``{author: change_count}`` from an unpacked ``document.xml``."""
    if not doc_xml_path.exists():
        return {}
    try:
        tree = ET.parse(doc_xml_path)
    except ET.ParseError:
        return {}

    ns = {"w": _WML_NS}
    attr_key = "{%s}author" % _WML_NS
    tally: dict[str, int] = {}
    for kind in ("ins", "del"):
        for el in tree.getroot().findall(".//w:%s" % kind, ns):
            who = el.get(attr_key)
            if who:
                tally[who] = tally.get(who, 0) + 1
    return tally


def _authors_inside_docx(docx_path: pathlib.Path) -> dict[str, int]:
    """Read author stats directly from a zipped ``.docx``."""
    try:
        with zipfile.ZipFile(docx_path, "r") as zf:
            if "word/document.xml" not in zf.namelist():
                return {}
            with zf.open("word/document.xml") as fh:
                tree = ET.parse(fh)

                ns = {"w": _WML_NS}
                attr_key = "{%s}author" % _WML_NS
                tally: dict[str, int] = {}
                for kind in ("ins", "del"):
                    for el in tree.getroot().findall(".//w:%s" % kind, ns):
                        who = el.get(attr_key)
                        if who:
                            tally[who] = tally.get(who, 0) + 1
                return tally
    except (zipfile.BadZipFile, ET.ParseError):
        return {}


def infer_author(modified_dir: pathlib.Path, original_docx: pathlib.Path, default: str = "Claude") -> str:
    """Guess which single author introduced new tracked changes."""
    mod_xml = modified_dir / "word" / "document.xml"
    mod_authors = get_tracked_change_authors(mod_xml)
    if not mod_authors:
        return default

    orig_authors = _authors_inside_docx(original_docx)

    delta: dict[str, int] = {}
    for who, n in mod_authors.items():
        diff = n - orig_authors.get(who, 0)
        if diff > 0:
            delta[who] = diff

    if not delta:
        return default
    if len(delta) == 1:
        return next(iter(delta))

    raise ValueError(
        "Multiple authors added new changes: %s. "
        "Cannot infer which author to validate." % delta
    )
