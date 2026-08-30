"""
Semantic validation of tracked changes (redlining) in Word documents.

Verifies that removing the nominated author's changes from the modified
document yields text identical to the original — i.e. all edits are
properly wrapped in ``<w:ins>``/``<w:del>`` markup.
"""

import pathlib
import subprocess
import tempfile
import zipfile


class RedliningValidator:
    """Compares original and modified DOCX text after stripping one author's revisions."""

    _WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

    def __init__(self, unpacked_dir, original_docx, verbose=False, author="Claude"):
        self._src_dir = pathlib.Path(unpacked_dir)
        self._orig    = pathlib.Path(original_docx)
        self._verbose = verbose
        self._author  = author
        self._ns      = {"w": self._WML}

    # kept for API compat
    @property
    def unpacked_dir(self):
        return self._src_dir

    @property
    def original_docx(self):
        return self._orig

    @property
    def verbose(self):
        return self._verbose

    @property
    def author(self):
        return self._author

    @property
    def namespaces(self):
        return self._ns

    def repair(self) -> int:
        return 0

    # ── Main check ───────────────────────────────────────────────────────

    def validate(self):
        mod_doc = self._src_dir / "word" / "document.xml"
        if not mod_doc.exists():
            print("FAILED - Modified document.xml not found at %s" % mod_doc)
            return False

        try:
            import xml.etree.ElementTree as ET

            m_root = ET.parse(mod_doc).getroot()
            del_elems = m_root.findall(".//w:del", self._ns)
            ins_elems = m_root.findall(".//w:ins", self._ns)

            a_key = "{%s}author" % self._WML
            has_del = any(e.get(a_key) == self._author for e in del_elems)
            has_ins = any(e.get(a_key) == self._author for e in ins_elems)

            if not has_del and not has_ins:
                if self._verbose:
                    print("PASSED - No tracked changes by %s found." % self._author)
                return True
        except Exception:
            pass

        with tempfile.TemporaryDirectory() as td:
            tp = pathlib.Path(td)
            try:
                with zipfile.ZipFile(self._orig, "r") as zf:
                    zf.extractall(tp)
            except Exception as exc:
                print("FAILED - Error unpacking original docx: %s" % exc)
                return False

            orig_doc = tp / "word" / "document.xml"
            if not orig_doc.exists():
                print("FAILED - Original document.xml not found in %s" % self._orig)
                return False

            try:
                import xml.etree.ElementTree as ET
                m_tree = ET.parse(mod_doc)
                o_tree = ET.parse(orig_doc)
            except ET.ParseError as exc:
                print("FAILED - Error parsing XML files: %s" % exc)
                return False

            self._strip_author_changes(o_tree.getroot())
            self._strip_author_changes(m_tree.getroot())

            txt_mod = self._gather_text(m_tree.getroot())
            txt_orig = self._gather_text(o_tree.getroot())

            if txt_mod != txt_orig:
                report = self._build_diff_report(txt_orig, txt_mod)
                print(report)
                return False

            if self._verbose:
                print("PASSED - All changes by %s are properly tracked" % self._author)
            return True

    # ── Diff reporting ───────────────────────────────────────────────────

    def _build_diff_report(self, old_txt, new_txt):
        lines = [
            "FAILED - Document text doesn't match after removing %s's tracked changes" % self._author,
            "",
            "Likely causes:",
            "  1. Modified text inside another author's <w:ins> or <w:del> tags",
            "  2. Made edits without proper tracked changes",
            "  3. Didn't nest <w:del> inside <w:ins> when deleting another's insertion",
            "",
            "For pre-redlined documents, use correct patterns:",
            "  - To reject another's INSERTION: Nest <w:del> inside their <w:ins>",
            "  - To restore another's DELETION: Add new <w:ins> AFTER their <w:del>",
            "",
        ]
        diff = self._word_diff(old_txt, new_txt)
        if diff:
            lines += ["Differences:", "============", diff]
        else:
            lines.append("Unable to generate word diff (git not available)")
        return "\n".join(lines)

    def _word_diff(self, old_txt, new_txt):
        """Attempt a character-level diff via ``git diff --word-diff``."""
        try:
            with tempfile.TemporaryDirectory() as td:
                tp = pathlib.Path(td)
                (tp / "a.txt").write_text(old_txt, encoding="utf-8")
                (tp / "b.txt").write_text(new_txt, encoding="utf-8")

                for extra_args in (["--word-diff-regex=."], []):
                    proc = subprocess.run(
                        ["git", "diff", "--word-diff=plain", "-U0", "--no-index",
                         str(tp / "a.txt"), str(tp / "b.txt")] + extra_args,
                        capture_output=True, text=True,
                    )
                    if proc.stdout.strip():
                        body: list[str] = []
                        active = False
                        for ln in proc.stdout.split("\n"):
                            if ln.startswith("@@"):
                                active = True
                                continue
                            if active and ln.strip():
                                body.append(ln)
                        if body:
                            return "\n".join(body)
        except (subprocess.CalledProcessError, FileNotFoundError, Exception):
            pass
        return None

    # ── XML manipulation ─────────────────────────────────────────────────

    def _strip_author_changes(self, root):
        """Remove the nominated author's ``<w:ins>`` and ``<w:del>`` from *root*."""
        ins_tag = "{%s}ins" % self._WML
        del_tag = "{%s}del" % self._WML
        a_attr  = "{%s}author" % self._WML

        # Pass 1 — drop author's insertions entirely
        for parent in root.iter():
            kills = [ch for ch in parent if ch.tag == ins_tag and ch.get(a_attr) == self._author]
            for k in kills:
                parent.remove(k)

        # Pass 2 — unwrap author's deletions (promote children)
        dt_tag = "{%s}delText" % self._WML
        t_tag  = "{%s}t" % self._WML

        for parent in root.iter():
            targets = [
                (ch, list(parent).index(ch))
                for ch in parent
                if ch.tag == del_tag and ch.get(a_attr) == self._author
            ]
            for del_el, idx in reversed(targets):
                for inner in del_el.iter():
                    if inner.tag == dt_tag:
                        inner.tag = t_tag
                for child in reversed(list(del_el)):
                    parent.insert(idx, child)
                parent.remove(del_el)

    def _gather_text(self, root) -> str:
        """Concatenate ``<w:t>`` content per paragraph, separated by newlines."""
        p_tag = "{%s}p" % self._WML
        t_tag = "{%s}t" % self._WML
        paragraphs: list[str] = []
        for p in root.findall(".//%s" % p_tag):
            parts = [t.text for t in p.findall(".//%s" % t_tag) if t.text]
            combined = "".join(parts)
            if combined:
                paragraphs.append(combined)
        return "\n".join(paragraphs)


if __name__ == "__main__":
    raise RuntimeError("This module should not be run directly.")
