"""Insert review annotations into an unpacked DOCX package.

Typical invocation::

    python comment.py unpacked/ 0 "Comment text"
    python comment.py unpacked/ 1 "Reply text" --parent 0

All text values must already contain proper XML escaping
(e.g. ``&amp;`` for ``&``, ``&#x2019;`` for a smart apostrophe).

After execution, manually wire the markers into ``document.xml``::

    <w:commentRangeStart w:id="0"/>
    ... annotated content ...
    <w:commentRangeEnd w:id="0"/>
    <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
"""

from __future__ import annotations

import argparse
import pathlib
import random
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final

import defusedxml.minidom

# ── Constants ────────────────────────────────────────────────────────────────

_TPL_DIR: Final[pathlib.Path] = pathlib.Path(__file__).parent / "templates"

_XML_NS_MAP: Final[dict[str, str]] = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16cex": "http://schemas.microsoft.com/office/word/2018/wordml/cex",
}

_NS_DECLARATIONS: Final[str] = " ".join(
    f'xmlns:{prefix}="{uri}"' for prefix, uri in _XML_NS_MAP.items()
)

_CURLY_QUOTE_MAP: Final[dict[str, str]] = {
    "\u201c": "&#x201C;",
    "\u201d": "&#x201D;",
    "\u2018": "&#x2018;",
    "\u2019": "&#x2019;",
}

# XML template for the comment body element.
_COMMENT_BODY_XML: Final[str] = (
    '<w:comment w:id="{cid}" w:author="{who}" w:date="{when}" w:initials="{ini}">'
    '<w:p w14:paraId="{pid}" w14:textId="77777777">'
    "<w:r>"
    '<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
    "<w:annotationRef/>"
    "</w:r>"
    "<w:r>"
    "<w:rPr>"
    '<w:color w:val="000000"/>'
    '<w:sz w:val="20"/>'
    '<w:szCs w:val="20"/>'
    "</w:rPr>"
    "<w:t>{body}</w:t>"
    "</w:r>"
    "</w:p>"
    "</w:comment>"
)

# User-facing hints for wiring markers into document.xml.
_STANDALONE_HINT: Final[str] = """
Add to document.xml (markers must be direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""

_REPLY_HINT: Final[str] = """
Nest markers inside parent {pid}'s markers (markers must be direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{pid}"/><w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/><w:commentRangeEnd w:id="{pid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{pid}"/></w:r>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""

# Relationship type URIs and their corresponding target file names.
_COMMENT_RELATIONSHIP_PAIRS: Final[list[tuple[str, str]]] = [
    (
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        "comments.xml",
    ),
    (
        "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
        "commentsExtended.xml",
    ),
    (
        "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
        "commentsIds.xml",
    ),
    (
        "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
        "commentsExtensible.xml",
    ),
]

# Content type declarations for comment-related parts.
_COMMENT_CONTENT_TYPE_PARTS: Final[list[tuple[str, str]]] = [
    (
        "/word/comments.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    ),
    (
        "/word/commentsExtended.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    ),
    (
        "/word/commentsIds.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml",
    ),
    (
        "/word/commentsExtensible.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml",
    ),
]


# ── Data structures ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CommentIdentifiers:
    """Generated identifiers for a single comment."""

    para_id: str
    durable_id: str
    timestamp: str


# ── Low-level XML helpers ────────────────────────────────────────────────────


def _rand_hex() -> str:
    """Generate a random 8-character hex ID within the valid OOXML range."""
    return f"{random.randint(0, 0x7FFFFFFE):08X}"


def _sanitize_curly_quotes(raw: str) -> str:
    """Replace Unicode typographic quotes with XML entity references."""
    result = raw
    for char, entity in _CURLY_QUOTE_MAP.items():
        result = result.replace(char, entity)
    return result


def _inject_xml_fragment(
    target_file: pathlib.Path, wrapper_tag: str, fragment: str
) -> None:
    """Parse *target_file*, append *fragment* as children of *wrapper_tag*, and save."""
    doc = defusedxml.minidom.parseString(target_file.read_text(encoding="utf-8"))
    container = doc.getElementsByTagName(wrapper_tag)[0]

    tmp_doc = defusedxml.minidom.parseString(f"<root {_NS_DECLARATIONS}>{fragment}</root>")
    for node in tmp_doc.documentElement.childNodes:
        if node.nodeType == node.ELEMENT_NODE:
            container.appendChild(doc.importNode(node, True))

    serialised = _sanitize_curly_quotes(doc.toxml(encoding="UTF-8").decode("utf-8"))
    target_file.write_text(serialised, encoding="utf-8")


# ── Relationship and content-type helpers ────────────────────────────────────


def _locate_para_id(comments_file: pathlib.Path, cid: int) -> str | None:
    """Return the ``w14:paraId`` for the comment whose ``w:id`` equals *cid*."""
    doc = defusedxml.minidom.parseString(comments_file.read_text(encoding="utf-8"))
    for comment_node in doc.getElementsByTagName("w:comment"):
        if comment_node.getAttribute("w:id") != str(cid):
            continue
        for p_node in comment_node.getElementsByTagName("w:p"):
            val = p_node.getAttribute("w14:paraId")
            if val:
                return val
    return None


def _highest_rid(rels_file: pathlib.Path) -> int:
    """Find the highest numeric relationship ID in a .rels file."""
    doc = defusedxml.minidom.parseString(rels_file.read_text(encoding="utf-8"))
    top = 0
    for rel_node in doc.getElementsByTagName("Relationship"):
        raw = rel_node.getAttribute("Id")
        if raw and raw.startswith("rId"):
            try:
                top = max(top, int(raw[3:]))
            except ValueError:
                continue
    return top


def _target_exists(rels_file: pathlib.Path, tgt: str) -> bool:
    """Check whether a relationship with the given Target already exists."""
    doc = defusedxml.minidom.parseString(rels_file.read_text(encoding="utf-8"))
    return any(
        r.getAttribute("Target") == tgt
        for r in doc.getElementsByTagName("Relationship")
    )


def _part_declared(ct_file: pathlib.Path, part: str) -> bool:
    """Check whether a content-type Override with the given PartName exists."""
    doc = defusedxml.minidom.parseString(ct_file.read_text(encoding="utf-8"))
    return any(
        o.getAttribute("PartName") == part
        for o in doc.getElementsByTagName("Override")
    )


def _wire_comment_rels(root_dir: pathlib.Path) -> None:
    """Register comment-related relationships in document.xml.rels."""
    rels = root_dir / "word" / "_rels" / "document.xml.rels"
    if not rels.exists():
        return
    if _target_exists(rels, "comments.xml"):
        return

    doc = defusedxml.minidom.parseString(rels.read_text(encoding="utf-8"))
    parent_elem = doc.documentElement
    rid_counter = _highest_rid(rels) + 1

    for rtype, tgt in _COMMENT_RELATIONSHIP_PAIRS:
        elem = doc.createElement("Relationship")
        elem.setAttribute("Id", f"rId{rid_counter}")
        elem.setAttribute("Type", rtype)
        elem.setAttribute("Target", tgt)
        parent_elem.appendChild(elem)
        rid_counter += 1

    rels.write_bytes(doc.toxml(encoding="UTF-8"))


def _wire_content_types(root_dir: pathlib.Path) -> None:
    """Register comment-related content types in [Content_Types].xml."""
    ct = root_dir / "[Content_Types].xml"
    if not ct.exists():
        return
    if _part_declared(ct, "/word/comments.xml"):
        return

    doc = defusedxml.minidom.parseString(ct.read_text(encoding="utf-8"))
    parent_elem = doc.documentElement

    for pname, ctype in _COMMENT_CONTENT_TYPE_PARTS:
        elem = doc.createElement("Override")
        elem.setAttribute("PartName", pname)
        elem.setAttribute("ContentType", ctype)
        parent_elem.appendChild(elem)

    ct.write_bytes(doc.toxml(encoding="UTF-8"))


# ── Comment XML part management ──────────────────────────────────────────────


def _ensure_comments_xml(word_dir: pathlib.Path, root_dir: pathlib.Path) -> pathlib.Path:
    """Ensure comments.xml exists, bootstrapping from template if needed."""
    cxml = word_dir / "comments.xml"
    if not cxml.exists():
        shutil.copy(_TPL_DIR / "comments.xml", cxml)
        _wire_comment_rels(root_dir)
        _wire_content_types(root_dir)
    return cxml


def _ensure_extended_xml(word_dir: pathlib.Path) -> pathlib.Path:
    """Ensure commentsExtended.xml exists."""
    ext = word_dir / "commentsExtended.xml"
    if not ext.exists():
        shutil.copy(_TPL_DIR / "commentsExtended.xml", ext)
    return ext


def _ensure_ids_xml(word_dir: pathlib.Path) -> pathlib.Path:
    """Ensure commentsIds.xml exists."""
    ids_file = word_dir / "commentsIds.xml"
    if not ids_file.exists():
        shutil.copy(_TPL_DIR / "commentsIds.xml", ids_file)
    return ids_file


def _ensure_extensible_xml(word_dir: pathlib.Path) -> pathlib.Path:
    """Ensure commentsExtensible.xml exists."""
    efile = word_dir / "commentsExtensible.xml"
    if not efile.exists():
        shutil.copy(_TPL_DIR / "commentsExtensible.xml", efile)
    return efile


def _write_comment_body(
    cxml: pathlib.Path,
    comment_id: int,
    text: str,
    author: str,
    initials: str,
    ids: CommentIdentifiers,
) -> None:
    """Append the comment element to comments.xml."""
    _inject_xml_fragment(
        cxml,
        "w:comments",
        _COMMENT_BODY_XML.format(
            cid=comment_id,
            who=author,
            when=ids.timestamp,
            ini=initials,
            pid=ids.para_id,
            body=text,
        ),
    )


def _write_extended_entry(
    ext: pathlib.Path,
    ids: CommentIdentifiers,
    parent_para_id: str | None,
) -> None:
    """Append the extended comment entry (with optional parent link)."""
    if parent_para_id is not None:
        fragment = (
            f'<w15:commentEx w15:paraId="{ids.para_id}" '
            f'w15:paraIdParent="{parent_para_id}" w15:done="0"/>'
        )
    else:
        fragment = f'<w15:commentEx w15:paraId="{ids.para_id}" w15:done="0"/>'
    _inject_xml_fragment(ext, "w15:commentsEx", fragment)


def _write_ids_entry(ids_file: pathlib.Path, ids: CommentIdentifiers) -> None:
    """Append the comment ID mapping entry."""
    fragment = (
        f'<w16cid:commentId w16cid:paraId="{ids.para_id}" '
        f'w16cid:durableId="{ids.durable_id}"/>'
    )
    _inject_xml_fragment(ids_file, "w16cid:commentsIds", fragment)


def _write_extensible_entry(efile: pathlib.Path, ids: CommentIdentifiers) -> None:
    """Append the extensible comment entry with UTC timestamp."""
    fragment = (
        f'<w16cex:commentExtensible w16cex:durableId="{ids.durable_id}" '
        f'w16cex:dateUtc="{ids.timestamp}"/>'
    )
    _inject_xml_fragment(efile, "w16cex:commentsExtensible", fragment)


# ── Public API ───────────────────────────────────────────────────────────────


def add_comment(
    unpacked_dir: str,
    comment_id: int,
    text: str,
    author: str = "Claude",
    initials: str = "C",
    parent_id: int | None = None,
) -> tuple[str, str]:
    """Register a new comment (or reply) across all required XML parts.

    Returns:
        A tuple of ``(para_id, message)`` describing the outcome.
    """
    root_dir = pathlib.Path(unpacked_dir)
    word_dir = root_dir / "word"

    if not word_dir.exists():
        return "", f"Error: {word_dir} not found"

    # Generate unique identifiers for this comment.
    ids = CommentIdentifiers(
        para_id=_rand_hex(),
        durable_id=_rand_hex(),
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )

    # 1. comments.xml — main comment body.
    cxml = _ensure_comments_xml(word_dir, root_dir)
    _write_comment_body(cxml, comment_id, text, author, initials, ids)

    # 2. commentsExtended.xml — parent linkage and done state.
    ext = _ensure_extended_xml(word_dir)
    parent_para_id: str | None = None
    if parent_id is not None:
        parent_para_id = _locate_para_id(cxml, parent_id)
        if parent_para_id is None:
            return "", f"Error: Parent comment {parent_id} not found"
    _write_extended_entry(ext, ids, parent_para_id)

    # 3. commentsIds.xml — paraId ↔ durableId mapping.
    ids_file = _ensure_ids_xml(word_dir)
    _write_ids_entry(ids_file, ids)

    # 4. commentsExtensible.xml — UTC timestamp metadata.
    efile = _ensure_extensible_xml(word_dir)
    _write_extensible_entry(efile, ids)

    kind = "reply" if parent_id is not None else "comment"
    return ids.para_id, f"Added {kind} {comment_id} (para_id={ids.para_id})"


# ── CLI entry point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Add comments to DOCX documents")
    p.add_argument("unpacked_dir", help="Unpacked DOCX directory")
    p.add_argument("comment_id", type=int, help="Comment ID (must be unique)")
    p.add_argument("text", help="Comment text")
    p.add_argument("--author", default="Claude", help="Author name")
    p.add_argument("--initials", default="C", help="Author initials")
    p.add_argument("--parent", type=int, help="Parent comment ID (for replies)")
    args = p.parse_args()

    para_id, msg = add_comment(
        args.unpacked_dir,
        args.comment_id,
        args.text,
        args.author,
        args.initials,
        args.parent,
    )
    print(msg)
    if "Error" in msg:
        sys.exit(1)
    cid = args.comment_id
    if args.parent is not None:
        print(_REPLY_HINT.format(pid=args.parent, cid=cid))
    else:
        print(_STANDALONE_HINT.format(cid=cid))
