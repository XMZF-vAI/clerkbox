"""
Word-specific schema and structural validation on unpacked DOCX packages.
"""

import random
import re
import tempfile
import zipfile

import defusedxml.minidom
import lxml.etree

from .base import BaseSchemaValidator


class DOCXSchemaValidator(BaseSchemaValidator):
    """Extends the base validator with DOCX-specific checks."""

    _NS_WML  = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    _NS_W14  = "http://schemas.microsoft.com/office/word/2010/wordml"
    _NS_CID  = "http://schemas.microsoft.com/office/word/2016/wordml/cid"

    WORD_2006_NAMESPACE = _NS_WML
    W14_NAMESPACE       = _NS_W14
    W16CID_NAMESPACE    = _NS_CID

    ELEMENT_RELATIONSHIP_TYPES = {}

    # ── Orchestrator ─────────────────────────────────────────────────────

    def validate(self):
        if not self.validate_xml():
            return False

        checks = [
            self.validate_namespaces,
            self.validate_unique_ids,
            self.validate_file_references,
            self.validate_content_types,
            self.validate_against_xsd,
            self._check_whitespace,
            self._check_deletions,
            self._check_insertions,
            self.validate_all_relationship_ids,
            self._check_id_bounds,
            self._check_comment_markers,
        ]
        ok = True
        for fn in checks:
            if not fn():
                ok = False

        self._report_paragraph_delta()
        return ok

    # ── Whitespace preservation ──────────────────────────────────────────

    def validate_whitespace_preservation(self):
        return self._check_whitespace()

    def _check_whitespace(self):
        issues: list[str] = []
        for fp in self.xml_files:
            if fp.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                space_attr = "{%s}space" % self.XML_NAMESPACE
                for t_el in root.iter("{%s}t" % self._NS_WML):
                    txt = t_el.text
                    if not txt:
                        continue
                    if re.search(r"^[ \t\n\r]", txt) or re.search(r"[ \t\n\r]$", txt):
                        if space_attr not in t_el.attrib or t_el.attrib[space_attr] != "preserve":
                            preview = repr(txt)[:50] + "..." if len(repr(txt)) > 50 else repr(txt)
                            issues.append(
                                "  %s: Line %s: w:t element with whitespace missing "
                                "xml:space='preserve': %s"
                                % (fp.relative_to(self.unpacked_dir), t_el.sourceline, preview))
            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found %d whitespace preservation violations:" % len(issues))
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - All whitespace is properly preserved")
        return True

    # ── Deletion correctness ─────────────────────────────────────────────

    def validate_deletions(self):
        return self._check_deletions()

    def _check_deletions(self):
        issues: list[str] = []
        ns = {"w": self._NS_WML}

        for fp in self.xml_files:
            if fp.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                for bad_t in root.xpath(".//w:del//w:t", namespaces=ns):
                    if bad_t.text:
                        preview = repr(bad_t.text)[:50] + "..." if len(repr(bad_t.text)) > 50 else repr(bad_t.text)
                        issues.append(
                            "  %s: Line %s: <w:t> found within <w:del>: %s"
                            % (fp.relative_to(self.unpacked_dir), bad_t.sourceline, preview))
                for bad_i in root.xpath(".//w:del//w:instrText", namespaces=ns):
                    preview = repr(bad_i.text or "")[:50] + "..." if len(repr(bad_i.text or "")) > 50 else repr(bad_i.text or "")
                    issues.append(
                        "  %s: Line %s: <w:instrText> found within <w:del> (use <w:delInstrText>): %s"
                        % (fp.relative_to(self.unpacked_dir), bad_i.sourceline, preview))
            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found %d deletion validation violations:" % len(issues))
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - No w:t elements found within w:del elements")
        return True

    # ── Insertion correctness ────────────────────────────────────────────

    def validate_insertions(self):
        return self._check_insertions()

    def _check_insertions(self):
        issues: list[str] = []
        ns = {"w": self._NS_WML}

        for fp in self.xml_files:
            if fp.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                for el in root.xpath(".//w:ins//w:delText[not(ancestor::w:del)]", namespaces=ns):
                    preview = repr(el.text or "")[:50] + "..." if len(repr(el.text or "")) > 50 else repr(el.text or "")
                    issues.append(
                        "  %s: Line %s: <w:delText> within <w:ins>: %s"
                        % (fp.relative_to(self.unpacked_dir), el.sourceline, preview))
            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found %d insertion validation violations:" % len(issues))
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - No w:delText elements within w:ins elements")
        return True

    # ── Paragraph count comparison ───────────────────────────────────────

    def count_paragraphs_in_unpacked(self):
        for fp in self.xml_files:
            if fp.name != "document.xml":
                continue
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                return len(root.findall(".//{%s}p" % self._NS_WML))
            except Exception as exc:
                print("Error counting paragraphs in unpacked document: %s" % exc)
        return 0

    def count_paragraphs_in_original(self):
        if self.original_file is None:
            return 0
        try:
            with tempfile.TemporaryDirectory() as td:
                with zipfile.ZipFile(self.original_file, "r") as zf:
                    zf.extractall(td)
                root = lxml.etree.parse(td + "/word/document.xml").getroot()
                return len(root.findall(".//{%s}p" % self._NS_WML))
        except Exception as exc:
            print("Error counting paragraphs in original document: %s" % exc)
        return 0

    def compare_paragraph_counts(self):
        self._report_paragraph_delta()

    def _report_paragraph_delta(self):
        before = self.count_paragraphs_in_original()
        after = self.count_paragraphs_in_unpacked()
        delta = after - before
        sign = "+%d" % delta if delta > 0 else str(delta)
        print("\nParagraphs: %d \u2192 %d (%s)" % (before, after, sign))

    # ── ID bound constraints ─────────────────────────────────────────────

    def _parse_id_value(self, raw: str, base: int = 16) -> int:
        return int(raw, base)

    def validate_id_constraints(self):
        return self._check_id_bounds()

    def _check_id_bounds(self):
        issues: list[str] = []
        pid_attr = "{%s}paraId" % self._NS_W14
        did_attr = "{%s}durableId" % self._NS_CID

        for fp in self.xml_files:
            try:
                for el in lxml.etree.parse(str(fp)).iter():
                    pval = el.get(pid_attr)
                    if pval and self._parse_id_value(pval, 16) >= 0x80000000:
                        issues.append(
                            "  %s:%s: paraId=%s >= 0x80000000" % (fp.name, el.sourceline, pval))

                    dval = el.get(did_attr)
                    if dval:
                        if fp.name == "numbering.xml":
                            try:
                                if self._parse_id_value(dval, 10) >= 0x7FFFFFFF:
                                    issues.append(
                                        "  %s:%s: durableId=%s >= 0x7FFFFFFF"
                                        % (fp.name, el.sourceline, dval))
                            except ValueError:
                                issues.append(
                                    "  %s:%s: durableId=%s must be decimal in numbering.xml"
                                    % (fp.name, el.sourceline, dval))
                        else:
                            if self._parse_id_value(dval, 16) >= 0x7FFFFFFF:
                                issues.append(
                                    "  %s:%s: durableId=%s >= 0x7FFFFFFF"
                                    % (fp.name, el.sourceline, dval))
            except Exception:
                pass

        if issues:
            print("FAILED - %d ID constraint violations:" % len(issues))
            for i in issues:
                print(i)
        elif self.verbose:
            print("PASSED - All paraId/durableId values within constraints")
        return not bool(issues)

    # ── Comment marker integrity ─────────────────────────────────────────

    def validate_comment_markers(self):
        return self._check_comment_markers()

    def _check_comment_markers(self):
        issues: list[str] = []
        doc_fp = None
        cmt_fp = None
        for fp in self.xml_files:
            if fp.name == "document.xml" and "word" in str(fp):
                doc_fp = fp
            elif fp.name == "comments.xml":
                cmt_fp = fp

        if doc_fp is None:
            if self.verbose:
                print("PASSED - No document.xml found (skipping comment validation)")
            return True

        try:
            ns = {"w": self._NS_WML}
            droot = lxml.etree.parse(str(doc_fp)).getroot()
            wid = "{%s}id" % self._NS_WML

            starts = {el.get(wid) for el in droot.xpath(".//w:commentRangeStart", namespaces=ns)}
            ends   = {el.get(wid) for el in droot.xpath(".//w:commentRangeEnd", namespaces=ns)}
            refs   = {el.get(wid) for el in droot.xpath(".//w:commentReference", namespaces=ns)}

            _key = lambda x: int(x) if x and x.isdigit() else 0

            for cid in sorted(ends - starts, key=_key):
                issues.append(
                    '  document.xml: commentRangeEnd id="%s" has no matching commentRangeStart' % cid)
            for cid in sorted(starts - ends, key=_key):
                issues.append(
                    '  document.xml: commentRangeStart id="%s" has no matching commentRangeEnd' % cid)

            if cmt_fp and cmt_fp.exists():
                croot = lxml.etree.parse(str(cmt_fp)).getroot()
                defined = {el.get(wid) for el in croot.xpath(".//w:comment", namespaces=ns)}
                all_markers = starts | ends | refs
                for cid in sorted(all_markers - defined, key=_key):
                    if cid:
                        issues.append(
                            '  document.xml: marker id="%s" references non-existent comment' % cid)

        except (lxml.etree.XMLSyntaxError, Exception) as exc:
            issues.append("  Error parsing XML: %s" % exc)

        if issues:
            print("FAILED - %d comment marker violations:" % len(issues))
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - All comment markers properly paired")
        return True

    # ── Repair: durableId overflow ───────────────────────────────────────

    def repair(self) -> int:
        n = super().repair()
        n += self._fix_durable_ids()
        return n

    def repair_durableId(self) -> int:
        return self._fix_durable_ids()

    def _fix_durable_ids(self) -> int:
        n = 0
        for fp in self.xml_files:
            try:
                raw = fp.read_text(encoding="utf-8")
                dom = defusedxml.minidom.parseString(raw)
                changed = False

                for el in dom.getElementsByTagName("*"):
                    if not el.hasAttribute("w16cid:durableId"):
                        continue
                    old = el.getAttribute("w16cid:durableId")
                    bad = False
                    if fp.name == "numbering.xml":
                        try:
                            bad = self._parse_id_value(old, 10) >= 0x7FFFFFFF
                        except ValueError:
                            bad = True
                    else:
                        try:
                            bad = self._parse_id_value(old, 16) >= 0x7FFFFFFF
                        except ValueError:
                            bad = True

                    if bad:
                        v = random.randint(1, 0x7FFFFFFE)
                        replacement = str(v) if fp.name == "numbering.xml" else "{:08X}".format(v)
                        el.setAttribute("w16cid:durableId", replacement)
                        print("  Repaired: %s: durableId %s \u2192 %s" % (fp.name, old, replacement))
                        n += 1
                        changed = True

                if changed:
                    fp.write_bytes(dom.toxml(encoding="UTF-8"))
            except Exception:
                pass
        return n


if __name__ == "__main__":
    raise RuntimeError("This module should not be run directly.")
