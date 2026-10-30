# Apple design review: Outpost workspace studies

Reviewed 27 October 2026 using the Apple design skill. **Rating: Good for HTML design exploration.** The common job is to understand the agent’s result, inspect its evidence, and make a scoped decision. Soft studio is the recommended starting point: it keeps the conversation and approval visible together without the extra task column of Dock.

## Verified

- All five options rendered at 1440, 1024, 768, and 390 CSS pixels in both light and dark appearance: **40 layout/appearance checks**. No page-wide horizontal overflow or unnamed icon buttons were found. Code diffs scroll within their own frame.
- Each option passed sample task selection, Review/Files/Activity switching, approval and undo, replies, request-changes focus, narrow navigation, and new-task creation. The five comparison frames load. No JavaScript exceptions were recorded.
- Real keyboard input verified arrow-key navigation and focus within the evidence tabs, and Escape dismissal of a dialog. Approval and undo retain focus on the next relevant control. All controls have visible focus styles.
- At 720 CSS pixels, the layout folds to a single pane and preserves review and reply access. At narrow widths, primary controls use 44 px targets. Desktop controls are at least 28 px tall; body text is 14–16 px with regular/medium weights.
- Increased contrast replaces secondary text with primary ink. Reduced motion has no animations. System appearance is the default; the appearance switch belongs to the study viewer for comparison.
- The local HTML and its comparison view were opened through a file URL without JavaScript exceptions. Fonts require no network.

### Computed text contrast

| Text / background | Contrast |
| --- | ---: |
| Dark primary #EDEDEF / #16171A | 15.33:1 |
| Dark secondary #A1A3A8 / #1C1D21 | 6.67:1 |
| Light primary #111113 / #FFFFFF | 18.86:1 |
| Light secondary #5C5E63 / #F4F4F2 | 5.89:1 |
| Dark diff added / removed | 8.61:1 / 6.75:1 |
| Light diff added / removed | 4.74:1 / 5.66:1 |

All listed text combinations exceed 4.5:1. Diff signs and status words carry meaning alongside color.

## Refinements made during review

- Enlarged narrow-layout controls, named both dialogs, added keyboard semantics to evidence tabs, prevented stacked dialogs, and retained focus after approval and undo.
- Anchored the Focus composer while its conversation scrolls, keeping reply available during review.
- Used one pane at narrow widths, with explicit Review/Conversation navigation instead of squeezing columns.
- Increased file labels and review controls to 13 px, kept regular text weights, and added press feedback.
- Removed unnecessary framing from Editorial while retaining a clear approval boundary. All layouts keep the source Ink palette and use semantic CSS color roles.

These decisions follow the local HIG references: `accessibility.md › Vision / Mobility` (contrast, text, target sizes); `layout.md › Visual hierarchy / Adaptability` (“Use progressive disclosure”); `typography.md › Conveying hierarchy / Using custom fonts`; `color.md › Best practices / Inclusive color`; `sidebars.md › Best practices / Desktop`; `split-views.md › Best practices / Phone`; `buttons.md › Best practices / Style`; `keyboards.md › Best practices`; and `generative-ai.md › Best practices / Outputs` (“Keep people in control”). Also consulted `designing-for-macos.md › Best practices` and the skill’s cross-platform translation.

## Craft and limits

Soft studio is balanced; Focus prioritizes reading; Horizon offers the widest conversation/evidence pairing; Editorial gives headings a distinct voice; Dock emphasizes switching between tasks. All use the same content and color roles, so the comparison concerns layout, type, and shape.

**Low:** The taste inspector flags the share of text below 13 px. The remaining 11–12 px text is metadata, source paths, timestamps, and code. Body copy is 14–16 px. The measured Soft studio inspection has zero failures and this one warning.

This is a desktop-first browser prototype, not native macOS acceptance. VoiceOver, real device touch, browser text-only enlargement, native menu/shortcut integration, Dynamic Type, and resizable native split dividers were not verified. Narrow-window reflow is tested; it does not establish a completed native iPhone design. Avenir Next is system-resolved and falls back on platforms without it. The original SwiftUI mock remains unchanged.

Evidence: [browser measurements](review/verification.json), [five-design comparison](review/compare.png). Screenshots were visually inspected in dark and light appearances at desktop and narrow widths.
