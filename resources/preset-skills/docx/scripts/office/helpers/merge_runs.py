"""Coalesce adjacent ``<w:r>`` elements that share identical formatting.

Operates on paragraphs *and* tracked-change containers (``<w:ins>``,
``<w:del>``).  Additionally strips RSID attributes from runs and removes
``proofErr`` spell/grammar markers that would otherwise prevent merging.
"""

import pathlib

import defusedxml.minidom


# ── DOM traversal utilities ──────────────────────────────────────────────────

def _collect_by_tag(root, tag: str) -> list:
    """Depth-first search for every element whose local name matches *tag*."""
    hits: list = []
    def _walk(nd):
        if nd.nodeType == nd.ELEMENT_NODE:
            lname = nd.localName or nd.tagName
            if lname == tag or lname.endswith(":%s" % tag):
                hits.append(nd)
            for ch in nd.childNodes:
                _walk(ch)
    _walk(root)
    return hits


def _child_by_tag(parent, tag: str):
    """Return the first direct child element matching *tag*, or ``None``."""
    for ch in parent.childNodes:
        if ch.nodeType != ch.ELEMENT_NODE:
            continue
        lname = ch.localName or ch.tagName
        if lname == tag or lname.endswith(":%s" % tag):
            return ch
    return None


def _children_by_tag(parent, tag: str) -> list:
    return [
        ch for ch in parent.childNodes
        if ch.nodeType == ch.ELEMENT_NODE
        and ((ch.localName or ch.tagName) == tag
             or (ch.localName or ch.tagName).endswith(":%s" % tag))
    ]


def _directly_adjacent(a, b) -> bool:
    """True when *a* and *b* are separated only by insignificant whitespace."""
    cur = a.nextSibling
    while cur is not None:
        if cur is b:
            return True
        if cur.nodeType == cur.ELEMENT_NODE:
            return False
        if cur.nodeType == cur.TEXT_NODE and cur.data.strip():
            return False
        cur = cur.nextSibling
    return False


def _tag_matches_run(nd) -> bool:
    lname = nd.localName or nd.tagName
    return lname == "r" or lname.endswith(":r")


# ── Cleanup passes ───────────────────────────────────────────────────────────

def _purge_elements(root, tag: str) -> None:
    for el in _collect_by_tag(root, tag):
        if el.parentNode:
            el.parentNode.removeChild(el)


def _erase_rsid_attributes(root) -> None:
    for rn in _collect_by_tag(root, "r"):
        doomed = [a for a in rn.attributes.values() if "rsid" in a.name.lower()]
        for attr in doomed:
            rn.removeAttribute(attr.name)


# ── Core merging logic ───────────────────────────────────────────────────────

def _formatting_equal(r1, r2) -> bool:
    rpr_a = _child_by_tag(r1, "rPr")
    rpr_b = _child_by_tag(r2, "rPr")
    if (rpr_a is None) != (rpr_b is None):
        return False
    return True if rpr_a is None else rpr_a.toxml() == rpr_b.toxml()


def _absorb_content(dest, src) -> None:
    """Move non-rPr children of *src* into *dest*."""
    for ch in list(src.childNodes):
        if ch.nodeType != ch.ELEMENT_NODE:
            continue
        lname = ch.localName or ch.tagName
        if lname == "rPr" or lname.endswith(":rPr"):
            continue
        dest.appendChild(ch)


def _next_elem(nd):
    sib = nd.nextSibling
    while sib is not None:
        if sib.nodeType == sib.ELEMENT_NODE:
            return sib
        sib = sib.nextSibling
    return None


def _next_run_sibling(nd):
    sib = nd.nextSibling
    while sib is not None:
        if sib.nodeType == sib.ELEMENT_NODE and _tag_matches_run(sib):
            return sib
        sib = sib.nextSibling
    return None


def _first_run_child(container):
    for ch in container.childNodes:
        if ch.nodeType == ch.ELEMENT_NODE and _tag_matches_run(ch):
            return ch
    return None


def _squash_text_nodes(run) -> None:
    """Combine consecutive ``<w:t>`` (or ``<w:delText>``) nodes inside *run*."""
    t_nodes = _children_by_tag(run, "t")
    idx = len(t_nodes) - 1
    while idx > 0:
        cur, prev = t_nodes[idx], t_nodes[idx - 1]
        if _directly_adjacent(prev, cur):
            txt_prev = prev.firstChild.data if prev.firstChild else ""
            txt_cur = cur.firstChild.data if cur.firstChild else ""
            combined = txt_prev + txt_cur
            if prev.firstChild:
                prev.firstChild.data = combined
            else:
                prev.appendChild(run.ownerDocument.createTextNode(combined))
            if combined[0:1] == " " or combined[-1:] == " ":
                prev.setAttribute("xml:space", "preserve")
            elif prev.hasAttribute("xml:space"):
                prev.removeAttribute("xml:space")
            run.removeChild(cur)
        idx -= 1


def _merge_within(container) -> int:
    """Merge consecutive runs with equal formatting inside *container*."""
    total = 0
    rn = _first_run_child(container)
    while rn is not None:
        while True:
            nxt = _next_elem(rn)
            if nxt is not None and _tag_matches_run(nxt) and _formatting_equal(rn, nxt):
                _absorb_content(rn, nxt)
                container.removeChild(nxt)
                total += 1
            else:
                break
        _squash_text_nodes(rn)
        rn = _next_run_sibling(rn)
    return total


# ── Public entry point ───────────────────────────────────────────────────────

def merge_runs(input_dir: str) -> tuple[int, str]:
    """Coalesce adjacent identically-formatted runs in ``document.xml``."""
    doc_path = pathlib.Path(input_dir) / "word" / "document.xml"
    if not doc_path.exists():
        return 0, "Error: %s not found" % doc_path

    try:
        dom = defusedxml.minidom.parseString(doc_path.read_text(encoding="utf-8"))
        top = dom.documentElement

        _purge_elements(top, "proofErr")
        _erase_rsid_attributes(top)

        parents = {rn.parentNode for rn in _collect_by_tag(top, "r")}
        merged = sum(_merge_within(p) for p in parents)

        doc_path.write_bytes(dom.toxml(encoding="UTF-8"))
        return merged, "Merged %d runs" % merged
    except Exception as exc:
        return 0, "Error: %s" % exc
