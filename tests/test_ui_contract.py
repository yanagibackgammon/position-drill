import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLES = (ROOT / "styles.css").read_text(encoding="utf-8")
GUIDE = (ROOT / "guide.html").read_text(encoding="utf-8")


class UIContractTests(unittest.TestCase):
    """Freeze the settled v125 visual design while implementation is maintained."""

    def test_design_tokens_stay_fixed(self):
        expected = {
            "--theme": "#B7924B",
            "--active": "#6F5424",
            "--black": "#000000",
            "--white": "#FFFFFF",
            "--gray": "#CFCFCF",
            "--line": "#657077",
            "--good": "#7EC797",
            "--bad": "#E38A8A",
            "--severe": "#C58CFF",
            "--font-xs": "11px",
            "--font-sm": "15px",
            "--font-md": "19px",
            "--font-lg": "23px",
            "--font-xl": "27px",
            "--title-mobile": "31px",
            "--title-desktop": "39px",
        }
        for name, value in expected.items():
            self.assertRegex(STYLES, rf"{re.escape(name)}\s*:\s*{re.escape(value)}\s*;")

    def test_only_approved_literal_font_sizes_are_used(self):
        approved = {11, 15, 19, 23, 27, 31, 39}
        for filename, source in (("styles.css", STYLES), ("guide.html", GUIDE)):
            literal_sizes = {
                int(value)
                for value in re.findall(r"font-size\s*:\s*(\d+)px\b", source)
            }
            self.assertTrue(
                literal_sizes <= approved,
                f"{filename} contains non-standard font sizes: {sorted(literal_sizes - approved)}",
            )

    def test_sort_modal_uses_settled_color_and_shadow_contract(self):
        self.assertNotIn("#242424", STYLES)
        self.assertNotIn("#111111", STYLES)
        self.assertRegex(STYLES, r"\.sort-filter-option:hover\s*\{\s*background:\s*var\(--line\)")
        self.assertRegex(STYLES, r"\.folder-option:hover\s*\{\s*background:\s*var\(--line\)")
        self.assertIn("box-shadow: none !important;", STYLES)

    def test_removed_legacy_menu_classes_do_not_return(self):
        legacy = (
            "filter-tab",
            "folder-modal-close",
            "folder-modal-header",
            "folder-modal-title",
            "menu-grid",
            "menu-group",
            "menu-slot",
            "selector-count",
        )
        for class_name in legacy:
            self.assertNotIn(f".{class_name}", STYLES)


if __name__ == "__main__":
    unittest.main()
