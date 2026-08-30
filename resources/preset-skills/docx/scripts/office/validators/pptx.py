"""
PowerPoint-specific XML validation against OOXML schemas.
"""

import re

from .base import BaseSchemaValidator


class PPTXSchemaValidator(BaseSchemaValidator):
    """Extends the base validator with PPTX-specific structural checks."""

    _PML_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

    PRESENTATIONML_NAMESPACE = _PML_NS

    ELEMENT_RELATIONSHIP_TYPES = {
        "sldid":         "slide",
        "sldmasterid":   "slidemaster",
        "notesmasterid": "notesmaster",
        "sldlayoutid":   "slidelayout",
        "themeid":       "theme",
        "tablestyleid":  "tablestyles",
    }

    # ── Orchestrator ─────────────────────────────────────────────────────

    def validate(self):
        if not self.validate_xml():
            return False

        ok = True
        for fn in (
            self.validate_namespaces,
            self.validate_unique_ids,
            self._check_uuid_format,
            self.validate_file_references,
            self._check_layout_ids,
            self.validate_content_types,
            self.validate_against_xsd,
            self._check_notes_refs,
            self.validate_all_relationship_ids,
            self._check_duplicate_layouts,
        ):
            if not fn():
                ok = False
        return ok

    # ── UUID format ──────────────────────────────────────────────────────

    def validate_uuid_ids(self):
        return self._check_uuid_format()

    def _check_uuid_format(self):
        import lxml.etree

        issues: list[str] = []
        _UUID_RE = re.compile(
            r"^[\{\(]?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}[\}\)]?$"
        )

        for fp in self.xml_files:
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                for el in root.iter():
                    for attr, val in el.attrib.items():
                        aname = attr.split("}")[-1].lower()
                        if aname != "id" and not aname.endswith("id"):
                            continue
                        if self._resembles_uuid(val) and not _UUID_RE.match(val):
                            issues.append(
                                "  %s: Line %s: ID '%s' appears to be a UUID but contains invalid hex characters"
                                % (fp.relative_to(self.unpacked_dir), el.sourceline, val))
            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found %d UUID ID validation errors:" % len(issues))
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - All UUID-like IDs contain valid hex values")
        return True

    @staticmethod
    def _resembles_uuid(val: str) -> bool:
        stripped = val.strip("{}()").replace("-", "")
        return len(stripped) == 32 and stripped.isalnum()

    # ── Slide-layout IDs in slide-masters ────────────────────────────────

    def validate_slide_layout_ids(self):
        return self._check_layout_ids()

    def _check_layout_ids(self):
        import lxml.etree

        issues: list[str] = []
        masters = list(self.unpacked_dir.glob("ppt/slideMasters/*.xml"))

        if not masters:
            if self.verbose:
                print("PASSED - No slide masters found")
            return True

        for sm in masters:
            try:
                root = lxml.etree.parse(str(sm)).getroot()
                rf = sm.parent / "_rels" / ("%s.rels" % sm.name)
                if not rf.exists():
                    issues.append(
                        "  %s: Missing relationships file: %s"
                        % (sm.relative_to(self.unpacked_dir), rf.relative_to(self.unpacked_dir)))
                    continue

                rroot = lxml.etree.parse(str(rf)).getroot()
                layout_rids = {
                    rel.get("Id")
                    for rel in rroot.findall("{%s}Relationship" % self.PACKAGE_RELATIONSHIPS_NAMESPACE)
                    if "slideLayout" in rel.get("Type", "")
                }

                for lid_el in root.findall(".//{%s}sldLayoutId" % self._PML_NS):
                    rid = lid_el.get("{%s}id" % self.OFFICE_RELATIONSHIPS_NAMESPACE)
                    lid = lid_el.get("id")
                    if rid and rid not in layout_rids:
                        issues.append(
                            "  %s: Line %s: sldLayoutId with id='%s' "
                            "references r:id='%s' which is not found in slide layout relationships"
                            % (sm.relative_to(self.unpacked_dir), lid_el.sourceline, lid, rid))

            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (sm.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found %d slide layout ID validation errors:" % len(issues))
            for i in issues:
                print(i)
            print("Remove invalid references or add missing slide layouts to the relationships file.")
            return False
        if self.verbose:
            print("PASSED - All slide layout IDs reference valid slide layouts")
        return True

    # ── Duplicate slide layouts per slide ────────────────────────────────

    def validate_no_duplicate_slide_layouts(self):
        return self._check_duplicate_layouts()

    def _check_duplicate_layouts(self):
        import lxml.etree

        issues: list[str] = []
        for rf in self.unpacked_dir.glob("ppt/slides/_rels/*.xml.rels"):
            try:
                root = lxml.etree.parse(str(rf)).getroot()
                layout_count = sum(
                    1 for rel in root.findall("{%s}Relationship" % self.PACKAGE_RELATIONSHIPS_NAMESPACE)
                    if "slideLayout" in rel.get("Type", "")
                )
                if layout_count > 1:
                    issues.append(
                        "  %s: has %d slideLayout references"
                        % (rf.relative_to(self.unpacked_dir), layout_count))
            except Exception as exc:
                issues.append("  %s: Error: %s" % (rf.relative_to(self.unpacked_dir), exc))

        if issues:
            print("FAILED - Found slides with duplicate slideLayout references:")
            for i in issues:
                print(i)
            return False
        if self.verbose:
            print("PASSED - All slides have exactly one slideLayout reference")
        return True

    # ── Notes-slide uniqueness ───────────────────────────────────────────

    def validate_notes_slide_references(self):
        return self._check_notes_refs()

    def _check_notes_refs(self):
        import lxml.etree

        issues: list[str] = []
        notes_map: dict[str, list] = {}

        rels_files = list(self.unpacked_dir.glob("ppt/slides/_rels/*.xml.rels"))
        if not rels_files:
            if self.verbose:
                print("PASSED - No slide relationship files found")
            return True

        for rf in rels_files:
            try:
                root = lxml.etree.parse(str(rf)).getroot()
                for rel in root.findall("{%s}Relationship" % self.PACKAGE_RELATIONSHIPS_NAMESPACE):
                    if "notesSlide" not in rel.get("Type", ""):
                        continue
                    tgt = rel.get("Target", "")
                    if not tgt:
                        continue
                    normalised = tgt.replace("../", "")
                    slide = rf.stem.replace(".xml", "")
                    notes_map.setdefault(normalised, []).append((slide, rf))
            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                issues.append("  %s: Error: %s" % (rf.relative_to(self.unpacked_dir), exc))

        for tgt, refs in notes_map.items():
            if len(refs) > 1:
                names = [r[0] for r in refs]
                issues.append("  Notes slide '%s' is referenced by multiple slides: %s" % (tgt, ", ".join(names)))
                for _, rf in refs:
                    issues.append("    - %s" % rf.relative_to(self.unpacked_dir))

        if issues:
            main_count = len([i for i in issues if not i.startswith("    ")])
            print("FAILED - Found %d notes slide reference validation errors:" % main_count)
            for i in issues:
                print(i)
            print("Each slide may optionally have its own slide file.")
            return False
        if self.verbose:
            print("PASSED - All notes slide references are unique")
        return True


if __name__ == "__main__":
    raise RuntimeError("This module should not be run directly.")
