"""
Foundation class providing shared validation primitives for Office XML packages.
"""

import re
import pathlib
import tempfile
import zipfile

import defusedxml.minidom
import lxml.etree


class BaseSchemaValidator:
    """Abstract base that concrete validators (DOCX, PPTX …) inherit from."""

    # Errors matching any of these substrings are silently suppressed.
    IGNORED_VALIDATION_ERRORS = [
        "hyphenationZone",
        "purl.org/dc/terms",
    ]

    # Mapping: element local-name  →  (id-attribute, scope)
    #   scope = "file"   → unique within the same XML file
    #   scope = "global" → unique across the entire package
    UNIQUE_ID_REQUIREMENTS = {
        "comment":          ("id", "file"),
        "commentrangestart": ("id", "file"),
        "commentrangeend":  ("id", "file"),
        "bookmarkstart":    ("id", "file"),
        "bookmarkend":      ("id", "file"),
        "sldid":            ("id", "file"),
        "sldmasterid":      ("id", "global"),
        "sldlayoutid":      ("id", "global"),
        "cm":               ("authorid", "file"),
        "sheet":            ("sheetid", "file"),
        "definedname":      ("id", "file"),
        "cxnsp":            ("id", "file"),
        "sp":               ("id", "file"),
        "pic":              ("id", "file"),
        "grpsp":            ("id", "file"),
    }

    EXCLUDED_ID_CONTAINERS = {"sectionlst"}

    ELEMENT_RELATIONSHIP_TYPES = {}

    SCHEMA_MAPPINGS = {
        "word":                   "ISO-IEC29500-4_2016/wml.xsd",
        "ppt":                    "ISO-IEC29500-4_2016/pml.xsd",
        "xl":                     "ISO-IEC29500-4_2016/sml.xsd",
        "[Content_Types].xml":    "ecma/fouth-edition/opc-contentTypes.xsd",
        "app.xml":                "ISO-IEC29500-4_2016/shared-documentPropertiesExtended.xsd",
        "core.xml":               "ecma/fouth-edition/opc-coreProperties.xsd",
        "custom.xml":             "ISO-IEC29500-4_2016/shared-documentPropertiesCustom.xsd",
        ".rels":                  "ecma/fouth-edition/opc-relationships.xsd",
        "people.xml":             "microsoft/wml-2012.xsd",
        "commentsIds.xml":        "microsoft/wml-cid-2016.xsd",
        "commentsExtensible.xml": "microsoft/wml-cex-2018.xsd",
        "commentsExtended.xml":   "microsoft/wml-2012.xsd",
        "chart":                  "ISO-IEC29500-4_2016/dml-chart.xsd",
        "theme":                  "ISO-IEC29500-4_2016/dml-main.xsd",
        "drawing":                "ISO-IEC29500-4_2016/dml-main.xsd",
    }

    MC_NAMESPACE  = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"

    PACKAGE_RELATIONSHIPS_NAMESPACE = (
        "http://schemas.openxmlformats.org/package/2006/relationships"
    )
    OFFICE_RELATIONSHIPS_NAMESPACE = (
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    )
    CONTENT_TYPES_NAMESPACE = (
        "http://schemas.openxmlformats.org/package/2006/content-types"
    )

    MAIN_CONTENT_FOLDERS = {"word", "ppt", "xl"}

    OOXML_NAMESPACES = {
        "http://schemas.openxmlformats.org/officeDocument/2006/math",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "http://schemas.openxmlformats.org/schemaLibrary/2006/main",
        "http://schemas.openxmlformats.org/drawingml/2006/main",
        "http://schemas.openxmlformats.org/drawingml/2006/chart",
        "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/diagram",
        "http://schemas.openxmlformats.org/drawingml/2006/picture",
        "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
        "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "http://schemas.openxmlformats.org/presentationml/2006/main",
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes",
        "http://www.w3.org/XML/1998/namespace",
    }

    # ── Initialisation ───────────────────────────────────────────────────

    def __init__(self, unpacked_dir, original_file=None, verbose=False):
        self.unpacked_dir = pathlib.Path(unpacked_dir).resolve()
        self.original_file = pathlib.Path(original_file) if original_file else None
        self.verbose = verbose

        self.schemas_dir = pathlib.Path(__file__).parent.parent / "schemas"

        self.xml_files = [
            fp
            for glob in ("*.xml", "*.rels")
            for fp in self.unpacked_dir.rglob(glob)
        ]

        if not self.xml_files:
            print("Warning: No XML files found in %s" % self.unpacked_dir)

    # ── Abstract interface ───────────────────────────────────────────────

    def validate(self):
        raise NotImplementedError("Subclasses must implement the validate method")

    def repair(self) -> int:
        return self._fix_whitespace_preservation()

    # ── Repair: xml:space="preserve" ─────────────────────────────────────

    def repair_whitespace_preservation(self) -> int:
        return self._fix_whitespace_preservation()

    def _fix_whitespace_preservation(self) -> int:
        n_fixed = 0
        for fp in self.xml_files:
            try:
                raw = fp.read_text(encoding="utf-8")
                dom = defusedxml.minidom.parseString(raw)
                touched = False

                for el in dom.getElementsByTagName("*"):
                    if not el.tagName.endswith(":t"):
                        continue
                    if el.firstChild is None:
                        continue
                    txt = el.firstChild.nodeValue
                    if txt and (txt.startswith((' ', '\t')) or txt.endswith((' ', '\t'))):
                        if el.getAttribute("xml:space") != "preserve":
                            el.setAttribute("xml:space", "preserve")
                            preview = repr(txt[:30]) + "..." if len(txt) > 30 else repr(txt)
                            print("  Repaired: %s: Added xml:space='preserve' to %s: %s"
                                  % (fp.name, el.tagName, preview))
                            n_fixed += 1
                            touched = True

                if touched:
                    fp.write_bytes(dom.toxml(encoding="UTF-8"))
            except Exception:
                pass
        return n_fixed

    # ── Well-formedness ──────────────────────────────────────────────────

    def validate_xml(self):
        problems: list[str] = []
        for fp in self.xml_files:
            try:
                lxml.etree.parse(str(fp))
            except lxml.etree.XMLSyntaxError as exc:
                problems.append("  %s: Line %d: %s"
                                % (fp.relative_to(self.unpacked_dir), exc.lineno, exc.msg))
            except Exception as exc:
                problems.append("  %s: Unexpected error: %s"
                                % (fp.relative_to(self.unpacked_dir), exc))

        if problems:
            print("FAILED - Found %d XML violations:" % len(problems))
            for p in problems:
                print(p)
            return False
        if self.verbose:
            print("PASSED - All XML files are well-formed")
        return True

    # ── Namespace coherence ──────────────────────────────────────────────

    def validate_namespaces(self):
        problems: list[str] = []
        for fp in self.xml_files:
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                declared = set(root.nsmap.keys()) - {None}
                for attr_val in [v for k, v in root.attrib.items() if k.endswith("Ignorable")]:
                    missing = set(attr_val.split()) - declared
                    problems.extend(
                        "  %s: Namespace '%s' in Ignorable but not declared"
                        % (fp.relative_to(self.unpacked_dir), ns)
                        for ns in missing
                    )
            except lxml.etree.XMLSyntaxError:
                continue

        if problems:
            print("FAILED - %d namespace issues:" % len(problems))
            for p in problems:
                print(p)
            return False
        if self.verbose:
            print("PASSED - All namespace prefixes properly declared")
        return True

    # ── ID uniqueness ────────────────────────────────────────────────────

    def validate_unique_ids(self):
        problems: list[str] = []
        gids: dict = {}

        for fp in self.xml_files:
            try:
                root = lxml.etree.parse(str(fp)).getroot()
                fids: dict = {}

                for mc_elem in root.xpath(".//mc:AlternateContent",
                                          namespaces={"mc": self.MC_NAMESPACE}):
                    mc_elem.getparent().remove(mc_elem)

                for el in root.iter():
                    raw_tag = el.tag.split("}")[-1].lower() if "}" in el.tag else el.tag.lower()

                    if raw_tag not in self.UNIQUE_ID_REQUIREMENTS:
                        continue

                    excluded = any(
                        anc.tag.split("}")[-1].lower() in self.EXCLUDED_ID_CONTAINERS
                        for anc in el.iterancestors()
                    )
                    if excluded:
                        continue

                    attr_name, scope = self.UNIQUE_ID_REQUIREMENTS[raw_tag]

                    id_val = None
                    for a, v in el.attrib.items():
                        a_local = a.split("}")[-1].lower() if "}" in a else a.lower()
                        if a_local == attr_name:
                            id_val = v
                            break

                    if id_val is None:
                        continue

                    if scope == "global":
                        if id_val in gids:
                            pf, pl, pt = gids[id_val]
                            problems.append(
                                "  %s: Line %s: Global ID '%s' in <%s> "
                                "already used in %s at line %s in <%s>"
                                % (fp.relative_to(self.unpacked_dir), el.sourceline,
                                   id_val, raw_tag, pf, pl, pt))
                        else:
                            gids[id_val] = (fp.relative_to(self.unpacked_dir),
                                            el.sourceline, raw_tag)
                    else:
                        key = (raw_tag, attr_name)
                        fids.setdefault(key, {})
                        if id_val in fids[key]:
                            problems.append(
                                "  %s: Line %s: Duplicate %s='%s' in <%s> "
                                "(first occurrence at line %s)"
                                % (fp.relative_to(self.unpacked_dir), el.sourceline,
                                   attr_name, id_val, raw_tag, fids[key][id_val]))
                        else:
                            fids[key][id_val] = el.sourceline

            except (lxml.etree.XMLSyntaxError, Exception) as exc:
                problems.append("  %s: Error: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if problems:
            print("FAILED - Found %d ID uniqueness violations:" % len(problems))
            for p in problems:
                print(p)
            return False
        if self.verbose:
            print("PASSED - All required IDs are unique")
        return True

    # ── Relationship file references ─────────────────────────────────────

    def validate_file_references(self):
        problems: list[str] = []
        rels_list = list(self.unpacked_dir.rglob("*.rels"))

        if not rels_list:
            if self.verbose:
                print("PASSED - No .rels files found")
            return True

        physical_files = [
            fp.resolve()
            for fp in self.unpacked_dir.rglob("*")
            if fp.is_file()
            and fp.name != "[Content_Types].xml"
            and not fp.name.endswith(".rels")
        ]

        touched: set = set()

        if self.verbose:
            print("Found %d .rels files and %d target files" % (len(rels_list), len(physical_files)))

        for rf in rels_list:
            try:
                rroot = lxml.etree.parse(str(rf)).getroot()
                rdir = rf.parent
                found_here: set = set()
                broken: list = []

                for rel in rroot.findall(".//ns:Relationship",
                                         namespaces={"ns": self.PACKAGE_RELATIONSHIPS_NAMESPACE}):
                    tgt = rel.get("Target")
                    if not tgt or tgt.startswith(("http", "mailto:")):
                        continue
                    if tgt.startswith("/"):
                        resolved = self.unpacked_dir / tgt.lstrip("/")
                    elif rf.name == ".rels":
                        resolved = self.unpacked_dir / tgt
                    else:
                        resolved = rdir.parent / tgt

                    try:
                        resolved = resolved.resolve()
                        if resolved.exists() and resolved.is_file():
                            found_here.add(resolved)
                            touched.add(resolved)
                        else:
                            broken.append((tgt, rel.sourceline))
                    except (OSError, ValueError):
                        broken.append((tgt, rel.sourceline))

                if broken:
                    rp = rf.relative_to(self.unpacked_dir)
                    for b_tgt, b_line in broken:
                        problems.append("  %s: Line %s: Broken reference to %s" % (rp, b_line, b_tgt))

            except Exception as exc:
                problems.append("  Error parsing %s: %s" % (rf.relative_to(self.unpacked_dir), exc))

        orphans = set(physical_files) - touched
        for o in sorted(orphans):
            problems.append("  Unreferenced file: %s" % o.relative_to(self.unpacked_dir))

        if problems:
            print("FAILED - Found %d relationship validation errors:" % len(problems))
            for p in problems:
                print(p)
            print(
                "CRITICAL: These errors will cause the document to appear corrupt. "
                + "Broken references MUST be fixed, "
                + "and unreferenced files MUST be referenced or removed."
            )
            return False
        if self.verbose:
            print("PASSED - All references are valid and all files are properly referenced")
        return True
    # ── Relationship ID cross-check ─────────────────────────────────────

    def validate_all_relationship_ids(self):
        import lxml.etree

        problems: list[str] = []

        for fp in self.xml_files:
            if fp.suffix == ".rels":
                continue

            rels_dir = fp.parent / "_rels"
            companion = rels_dir / ("%s.rels" % fp.name)
            if not companion.exists():
                continue

            try:
                rroot = lxml.etree.parse(str(companion)).getroot()
                rid_map: dict[str, str] = {}

                for rel in rroot.findall("{%s}Relationship" % self.PACKAGE_RELATIONSHIPS_NAMESPACE):
                    rid = rel.get("Id")
                    rtype = rel.get("Type", "")
                    if not rid:
                        continue
                    if rid in rid_map:
                        problems.append(
                            "  %s: Line %s: Duplicate relationship ID '%s' (IDs must be unique)"
                            % (companion.relative_to(self.unpacked_dir), rel.sourceline, rid))
                    type_short = rtype.rsplit("/", 1)[-1] if "/" in rtype else rtype
                    rid_map[rid] = type_short

                xroot = lxml.etree.parse(str(fp)).getroot()
                r_ns = self.OFFICE_RELATIONSHIPS_NAMESPACE
                for el in xroot.iter():
                    for aname in ("id", "embed", "link"):
                        ref = el.get("{%s}%s" % (r_ns, aname))
                        if not ref:
                            continue
                        xrp = fp.relative_to(self.unpacked_dir)
                        ename = el.tag.split("}")[-1] if "}" in el.tag else el.tag

                        if ref not in rid_map:
                            top5 = ", ".join(sorted(rid_map.keys())[:5])
                            suffix = "..." if len(rid_map) > 5 else ""
                            problems.append(
                                "  %s: Line %s: <%s> r:%s references non-existent relationship '%s' "
                                "(valid IDs: %s%s)"
                                % (xrp, el.sourceline, ename, aname, ref, top5, suffix))
                        elif aname == "id" and self.ELEMENT_RELATIONSHIP_TYPES:
                            expected = self._get_expected_relationship_type(ename)
                            if expected and expected not in rid_map[ref].lower():
                                problems.append(
                                    "  %s: Line %s: <%s> references '%s' which points to '%s' "
                                    "but should point to a '%s' relationship"
                                    % (xrp, el.sourceline, ename, ref, rid_map[ref], expected))

            except Exception as exc:
                problems.append("  Error processing %s: %s" % (fp.relative_to(self.unpacked_dir), exc))

        if problems:
            print("FAILED - Found %d relationship ID reference errors:" % len(problems))
            for p in problems:
                print(p)
            print("\nThese ID mismatches will cause the document to appear corrupt!")
            return False
        if self.verbose:
            print("PASSED - All relationship ID references are valid")
        return True

    def _get_expected_relationship_type(self, element_name):
        low = element_name.lower()

        if low in self.ELEMENT_RELATIONSHIP_TYPES:
            return self.ELEMENT_RELATIONSHIP_TYPES[low]

        if low.endswith("id") and len(low) > 2:
            stem = low[:-2]
            if stem.endswith("master") or stem.endswith("layout"):
                return stem
            return "slide" if stem == "sld" else stem

        if low.endswith("reference") and len(low) > 9:
            return low[:-9]

        return None

    # ── Content-type declarations ────────────────────────────────────────

    def validate_content_types(self):
        problems: list[str] = []
        ct_file = self.unpacked_dir / "[Content_Types].xml"
        if not ct_file.exists():
            print("FAILED - [Content_Types].xml file not found")
            return False

        try:
            ct_root = lxml.etree.parse(str(ct_file)).getroot()
            declared_parts: set[str] = set()
            declared_exts: set[str] = set()

            for ov in ct_root.findall("{%s}Override" % self.CONTENT_TYPES_NAMESPACE):
                pname = ov.get("PartName")
                if pname is not None:
                    declared_parts.add(pname.lstrip("/"))

            for df in ct_root.findall("{%s}Default" % self.CONTENT_TYPES_NAMESPACE):
                ext = df.get("Extension")
                if ext is not None:
                    declared_exts.add(ext.lower())

            _declarable = {
                "sld", "sldLayout", "sldMaster", "presentation",
                "document", "workbook", "worksheet", "theme",
            }

            _media_ct = {
                "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "bmp": "image/bmp", "tiff": "image/tiff",
                "wmf": "image/x-wmf", "emf": "image/x-emf",
            }

            for xf in self.xml_files:
                rel = str(xf.relative_to(self.unpacked_dir)).replace("\\", "/")
                if any(s in rel for s in (".rels", "[Content_Types]", "docProps/", "_rels/")):
                    continue
                try:
                    rtag = lxml.etree.parse(str(xf)).getroot().tag
                    rname = rtag.split("}")[-1] if "}" in rtag else rtag
                    if rname in _declarable and rel not in declared_parts:
                        problems.append(
                            "  %s: File with <%s> root not declared in [Content_Types].xml"
                            % (rel, rname))
                except Exception:
                    continue

            for fp in self.unpacked_dir.rglob("*"):
                if not fp.is_file():
                    continue
                if fp.suffix.lower() in {".xml", ".rels"}:
                    continue
                if fp.name == "[Content_Types].xml":
                    continue
                if "_rels" in fp.parts or "docProps" in fp.parts:
                    continue
                ext = fp.suffix.lstrip(".").lower()
                if ext and ext not in declared_exts and ext in _media_ct:
                    problems.append(
                        '  %s: File with extension \'%s\' not declared in [Content_Types].xml '
                        '- should add: <Default Extension="%s" ContentType="%s"/>'
                        % (fp.relative_to(self.unpacked_dir), ext, ext, _media_ct[ext]))

        except Exception as exc:
            problems.append("  Error parsing [Content_Types].xml: %s" % exc)

        if problems:
            print("FAILED - Found %d content type declaration errors:" % len(problems))
            for p in problems:
                print(p)
            return False
        if self.verbose:
            print("PASSED - All content files are properly declared in [Content_Types].xml")
        return True

    # ── Single-file XSD validation ───────────────────────────────────────

    def validate_file_against_xsd(self, xml_file, verbose=False):
        xml_file = pathlib.Path(xml_file).resolve()
        base = self.unpacked_dir.resolve()

        ok, cur_errs = self._check_single_xsd(xml_file, base)

        if ok is None:
            return None, set()
        if ok:
            return True, set()

        orig_errs = self._original_errors(xml_file)

        assert cur_errs is not None
        fresh = cur_errs - orig_errs
        fresh = {e for e in fresh
                 if not any(pat in e for pat in self.IGNORED_VALIDATION_ERRORS)}

        if fresh:
            if verbose:
                rp = xml_file.relative_to(base)
                print("FAILED - %s: %d new error(s)" % (rp, len(fresh)))
                for e in list(fresh)[:3]:
                    trunc = (e[:250] + "...") if len(e) > 250 else e
                    print("  - %s" % trunc)
            return False, fresh
        if verbose:
            print("PASSED - No new errors (original had %d errors)" % len(cur_errs))
        return True, set()

    # ── Batch XSD validation ─────────────────────────────────────────────

    def validate_against_xsd(self):
        fresh_errors: list[str] = []
        orig_err_count = 0
        ok_count = 0
        skip_count = 0

        for fp in self.xml_files:
            rp = str(fp.relative_to(self.unpacked_dir))
            ok, file_errs = self.validate_file_against_xsd(fp, verbose=False)

            if ok is None:
                skip_count += 1
            elif ok and not file_errs:
                ok_count += 1
            elif ok:
                orig_err_count += 1
                ok_count += 1
            else:
                fresh_errors.append("  %s: %d new error(s)" % (rp, len(file_errs)))
                for e in list(file_errs)[:3]:
                    fresh_errors.append(
                        "    - %s..." % e[:250] if len(e) > 250 else "    - %s" % e)

        if self.verbose:
            print("Validated %d files:" % len(self.xml_files))
            print("  - Valid: %d" % ok_count)
            print("  - Skipped (no schema): %d" % skip_count)
            if orig_err_count:
                print("  - With original errors (ignored): %d" % orig_err_count)
            n_err_files = len([ln for ln in fresh_errors if not ln.startswith("    ")])
            print("  - With NEW errors: %d" % n_err_files)

        if fresh_errors:
            print("\nFAILED - Found NEW validation errors:")
            for ln in fresh_errors:
                print(ln)
            return False
        if self.verbose:
            print("\nPASSED - No new XSD validation errors introduced")
        return True

    # ── Internal: schema resolution ──────────────────────────────────────

    def _get_schema_path(self, fp):
        if fp.name in self.SCHEMA_MAPPINGS:
            return self.schemas_dir / self.SCHEMA_MAPPINGS[fp.name]
        if fp.suffix == ".rels":
            return self.schemas_dir / self.SCHEMA_MAPPINGS[".rels"]
        if "charts/" in str(fp) and fp.name.startswith("chart"):
            return self.schemas_dir / self.SCHEMA_MAPPINGS["chart"]
        if "theme/" in str(fp) and fp.name.startswith("theme"):
            return self.schemas_dir / self.SCHEMA_MAPPINGS["theme"]
        if fp.parent.name in self.MAIN_CONTENT_FOLDERS:
            return self.schemas_dir / self.SCHEMA_MAPPINGS[fp.parent.name]
        return None

    # ── Internal: MC namespace stripping ─────────────────────────────────

    def _clean_ignorable_namespaces(self, tree):
        xml_str = lxml.etree.tostring(tree, encoding="unicode")
        copy = lxml.etree.fromstring(xml_str)

        for el in copy.iter():
            bad_attrs = [a for a in el.attrib
                         if "{" in a and a.split("}")[0][1:] not in self.OOXML_NAMESPACES]
            for a in bad_attrs:
                del el.attrib[a]

        self._drop_non_ooxml_elements(copy)
        return lxml.etree.ElementTree(copy)

    def _drop_non_ooxml_elements(self, root):
        doomed = []
        for child in list(root):
            if not hasattr(child, "tag") or callable(child.tag):
                continue
            tag_s = str(child.tag)
            if tag_s.startswith("{"):
                ns = tag_s.split("}")[0][1:]
                if ns not in self.OOXML_NAMESPACES:
                    doomed.append(child)
                    continue
            self._drop_non_ooxml_elements(child)
        for d in doomed:
            root.remove(d)

    def _strip_mc_ignorable(self, tree):
        rt = tree.getroot()
        key = "{%s}Ignorable" % self.MC_NAMESPACE
        if key in rt.attrib:
            del rt.attrib[key]
        return tree

    # ── Internal: XSD check for one file ─────────────────────────────────

    def _check_single_xsd(self, fp, base):
        schema_path = self._get_schema_path(fp)
        if schema_path is None:
            return None, None

        try:
            with open(schema_path, "rb") as fh:
                xsd_doc = lxml.etree.parse(fh, parser=lxml.etree.XMLParser(),
                                           base_url=str(schema_path))
                schema = lxml.etree.XMLSchema(xsd_doc)

            # Open in binary mode so lxml reads the encoding from the XML
            # declaration. Text mode would fall back to the platform default
            # encoding (GBK on Chinese Windows) and fail on UTF-8 XML.
            with open(fp, "rb") as fh:
                xml_tree = lxml.etree.parse(fh)

            xml_tree, _ = self._scrub_template_placeholders(xml_tree)
            xml_tree = self._strip_mc_ignorable(xml_tree)

            rp = fp.relative_to(base)
            if rp.parts and rp.parts[0] in self.MAIN_CONTENT_FOLDERS:
                xml_tree = self._clean_ignorable_namespaces(xml_tree)

            if schema.validate(xml_tree):
                return True, set()
            return False, {err.message for err in schema.error_log}
        except Exception as exc:
            return False, {str(exc)}

    # ── Internal: original-file error baseline ───────────────────────────

    def _original_errors(self, fp):
        if self.original_file is None:
            return set()

        fp = pathlib.Path(fp).resolve()
        base = self.unpacked_dir.resolve()
        rp = fp.relative_to(base)

        with tempfile.TemporaryDirectory() as td:
            tp = pathlib.Path(td)
            with zipfile.ZipFile(self.original_file, "r") as zf:
                zf.extractall(tp)
            orig_fp = tp / rp
            if not orig_fp.exists():
                return set()
            _, errs = self._check_single_xsd(orig_fp, tp)
            return errs if errs else set()

    # ── Internal: template-tag removal ───────────────────────────────────

    def _scrub_template_placeholders(self, tree):
        warnings: list[str] = []
        pat = re.compile(r"\{\{[^}]*\}\}")

        xml_str = lxml.etree.tostring(tree, encoding="unicode")
        copy = lxml.etree.fromstring(xml_str)

        def _clean(txt, kind):
            if not txt:
                return txt
            hits = list(pat.finditer(txt))
            if hits:
                warnings.extend("Found template tag in %s: %s" % (kind, m.group()) for m in hits)
                return pat.sub("", txt)
            return txt

        for el in copy.iter():
            if not hasattr(el, "tag") or callable(el.tag):
                continue
            tag_s = str(el.tag)
            if tag_s.endswith("}t") or tag_s == "t":
                continue
            el.text = _clean(el.text, "text content")
            el.tail = _clean(el.tail, "tail content")

        return lxml.etree.ElementTree(copy), warnings


if __name__ == "__main__":
    raise RuntimeError("This module should not be run directly.")
