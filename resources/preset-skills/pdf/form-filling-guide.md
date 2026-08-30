# PDF Form Filling Guide

**CRITICAL: You MUST complete these steps in order. Do not skip ahead to writing code.**

Before attempting to fill a PDF form, determine whether it contains interactive fields. Execute the following from this file's directory:
`python scripts/check_fillable_fields.py <file.pdf>`, then proceed to either the "Interactive Form Fields" or "Static Form Layout" section based on the output.

---

## Interactive Form Fields

When the PDF contains native fillable widgets:

### Step 1: Extract Field Metadata

Run (from this file's directory):
`python scripts/extract_form_field_info.py <input.pdf> <field_info.json>`

The resulting JSON uses this schema:
```json
[
  {
    "field_id": "(canonical identifier for the widget)",
    "page": "(1-indexed page number)",
    "rect": "([left, bottom, right, top] in PDF coordinate space where y=0 is page bottom)",
    "type": "text"
  },
  {
    "field_id": "(canonical identifier)",
    "page": "(1-indexed page number)",
    "type": "checkbox",
    "checked_value": "(assign this to activate the checkbox)",
    "unchecked_value": "(assign this to deactivate the checkbox)"
  },
  {
    "field_id": "(canonical identifier)",
    "page": "(1-indexed page number)",
    "type": "radio_group",
    "radio_options": [
      {
        "value": "(assign this to select the option)",
        "rect": "(bounding rectangle for this specific button)"
      }
    ]
  },
  {
    "field_id": "(canonical identifier)",
    "page": "(1-indexed page number)",
    "type": "choice",
    "choice_options": [
      {
        "value": "(assign this to pick the item)",
        "text": "(human-readable label)"
      }
    ]
  }
]
```

### Step 2: Visual Inspection

Render the document as page images (run from this file's directory):
`python scripts/convert_pdf_to_images.py <file.pdf> <output_directory>`

Inspect each image to understand what data each widget expects (remember to map PDF bounding box coordinates to image pixel space).

### Step 3: Assemble Field Values

Build a `field_values.json` specifying data for each widget:
```json
[
  {
    "field_id": "last_name",
    "description": "The user's last name",
    "page": 1,
    "value": "Simpson"
  },
  {
    "field_id": "Checkbox12",
    "description": "Checkbox to be checked if the user is 18 or over",
    "page": 1,
    "value": "/On"
  }
]
```

Notes:
- `field_id` must correspond to the extraction step output
- `page` must align with the page number from field_info.json
- For checkboxes, use `checked_value` to activate; for radio groups use one of the `value` entries from `radio_options`

### Step 4: Execute Fill Operation

Run (from this file's directory):
`python scripts/fill_fillable_fields.py <input.pdf> <field_values.json> <output.pdf>`

The script validates all identifiers and values; correct any reported errors and re-run.

---

## Static Form Layout

When the document lacks interactive widgets, text annotations will be positioned manually. First attempt structural analysis (higher precision), falling back to visual methods when necessary.

### Phase 1: Structural Analysis

Execute the layout analyzer to locate text elements, ruling lines, and checkbox shapes with precise coordinates:
`python scripts/extract_form_structure.py <input.pdf> form_structure.json`

The output contains:
- **labels**: All text tokens with precise positioning (x0, top, x1, bottom in PDF points)
- **lines**: Horizontal rules defining row separators
- **checkboxes**: Small square shapes detected as tick-boxes (includes center coordinates)
- **row_boundaries**: Computed row extents derived from horizontal rules

**Decision point**: If `form_structure.json` yields meaningful text labels matching visible form fields, proceed with **Method A: Coordinate-Driven Placement**. For scanned/rasterized PDFs with sparse or garbled labels, use **Method B: Visual Positioning**.

---

### Method A: Coordinate-Driven Placement (Preferred)

Applicable when `extract_form_structure.py` successfully identifies text labels.

#### A.1: Interpret the Layout Data

Examine form_structure.json to determine:

1. **Composite labels**: Adjacent tokens forming a single heading (e.g., "Last" + "Name")
2. **Row alignment**: Tokens sharing similar `top` values occupy the same horizontal band
3. **Entry zones**: Input areas begin after label endpoints (x0 = label.x1 + gap)
4. **Tick-boxes**: Use checkbox coordinates verbatim from the structural data

**Coordinate convention**: Origin at top-left corner; y increases downward.

#### A.2: Identify Structural Gaps

The analyzer may miss certain visual elements:
- **Round tick-boxes**: Only rectangular shapes are detected
- **Decorative graphics**: Non-standard form controls or ornamental elements
- **Low-contrast elements**: Faint or light-colored items may not register

For any form elements visible in rendered images but absent from form_structure.json, apply **visual analysis** for those specific items (see "Combined Approach" below).

#### A.3: Construct fields.json Using PDF Coordinates

Derive entry positions from the structural data:

**Text input areas:**
- entry x0 = label x1 + 5 (small gap after label)
- entry x1 = next label's x0, or row boundary
- entry top = same as label top
- entry bottom = row boundary line below, or label bottom + row_height

**Tick-boxes:**
- Use rectangle coordinates directly from form_structure.json
- entry_bounding_box = [checkbox.x0, checkbox.top, checkbox.x1, checkbox.bottom]

Build fields.json with `pdf_width` and `pdf_height` (indicating native coordinates):
```json
{
  "pages": [
    {"page_number": 1, "pdf_width": 612, "pdf_height": 792}
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name entry field",
      "field_label": "Last Name",
      "label_bounding_box": [43, 63, 87, 73],
      "entry_bounding_box": [92, 63, 260, 79],
      "entry_text": {"text": "Smith", "font_size": 10}
    },
    {
      "page_number": 1,
      "description": "US Citizen Yes checkbox",
      "field_label": "Yes",
      "label_bounding_box": [260, 200, 280, 210],
      "entry_bounding_box": [285, 197, 292, 205],
      "entry_text": {"text": "X"}
    }
  ]
}
```

**Key**: Specify `pdf_width`/`pdf_height` and use coordinates taken directly from form_structure.json.

#### A.4: Validate Geometry

Prior to filling, verify bounding box integrity:
`python scripts/check_bounding_boxes.py fields.json`

This detects overlapping rectangles and entry boxes too small for their font size. Resolve all reported issues before proceeding.

---

### Method B: Visual Positioning (Fallback)

Applicable when the PDF is rasterized/scanned and structural analysis yields no usable text (e.g., all content appears as "(cid:X)" patterns).

#### B.1: Render Document Pages

`python scripts/convert_pdf_to_images.py <input.pdf> <images_dir/>`

#### B.2: Rough Field Location

Scan each rendered page to catalogue form regions and approximate positions:
- Label text and estimated pixel locations
- Input zones (underlines, boxes, blank areas)
- Tick-boxes and their rough locations

Record approximate pixel coordinates for each element (precision not critical at this stage).

#### B.3: Precision Refinement via Cropping (ESSENTIAL)

For each field, isolate a region around the initial estimate to pin down exact coordinates.

**Produce a magnified crop with ImageMagick:**
```bash
magick <page_image> -crop <width>x<height>+<x>+<y> +repage <crop_output.png>
```

Parameters:
- `<x>, <y>` = top-left of crop region (rough estimate minus padding)
- `<width>, <height>` = crop dimensions (field area plus ~50px padding per side)

**Example:** Refining a "Name" field estimated near (100, 150):
```bash
magick images_dir/page_1.png -crop 300x80+50+120 +repage crops/name_field.png
```

(Note: if the `magick` command isn't available, try `convert` with the same arguments).

**Analyze the crop** to determine exact boundaries:
1. Pinpoint where the input zone starts (after label)
2. Pinpoint where it ends (before next element or page edge)
3. Identify vertical extent of the input area

**Map crop-local coordinates back to full-page space:**
- full_x = crop_x + crop_offset_x
- full_y = crop_y + crop_offset_y

Example: Crop origin at (50, 120), entry box at (52, 18) within crop:
- entry_x0 = 52 + 50 = 102
- entry_top = 18 + 120 = 138

**Process each field**, batching adjacent elements into shared crops where feasible.

#### B.4: Build fields.json with Pixel Coordinates

Construct fields.json using `image_width` and `image_height` (indicating pixel-space coordinates):
```json
{
  "pages": [
    {"page_number": 1, "image_width": 1700, "image_height": 2200}
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name entry field",
      "field_label": "Last Name",
      "label_bounding_box": [120, 175, 242, 198],
      "entry_bounding_box": [255, 175, 720, 218],
      "entry_text": {"text": "Smith", "font_size": 10}
    }
  ]
}
```

**Key**: Specify `image_width`/`image_height` and use refined pixel values from the cropping analysis.

#### B.5: Validate Geometry

Prior to filling, verify bounding box integrity:
`python scripts/check_bounding_boxes.py fields.json`

This detects overlapping rectangles and entry boxes too small for their font size. Resolve all reported issues before proceeding.

---

### Combined Approach: Structure + Visual

Applicable when structural analysis succeeds for most fields but misses certain elements (e.g., circular tick-boxes, non-standard controls).

1. **Apply Method A** for all elements present in form_structure.json
2. **Render pages** for visual inspection of missing elements
3. **Apply crop-based refinement** (from Method B) for undetected items
4. **Unify coordinate systems**: Structure-derived values are already in PDF space. For visually-estimated values, convert:
   - pdf_x = image_x * (pdf_width / image_width)
   - pdf_y = image_y * (pdf_height / image_height)
5. **Express everything in PDF coordinates** using `pdf_width`/`pdf_height` in the final fields.json

---

## Pre-Fill Validation

**Always run geometry checks before filling:**
`python scripts/check_bounding_boxes.py fields.json`

Detects:
- Overlapping bounding boxes (would produce garbled text)
- Entry regions too small for the specified text size

Correct all flagged issues in fields.json before continuing.

## Apply Annotations

The annotation engine automatically handles coordinate system detection and conversion:
`python scripts/fill_pdf_form_with_annotations.py <input.pdf> fields.json <output.pdf>`

## Visual Confirmation

Render the completed PDF and inspect text placement:
`python scripts/convert_pdf_to_images.py <output.pdf> <verify_images/>`

Troubleshooting misaligned text:
- **Method A**: Confirm you used PDF coordinates from form_structure.json with `pdf_width`/`pdf_height`
- **Method B**: Verify image dimensions match and pixel coordinates are accurately measured
- **Combined**: Double-check conversion math for visually-estimated fields
