# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension for text-to-speech page reading. Uses browser's native Web Speech API with a floating toolbar UI (not popup-based).

## Development

**No build process** - pure vanilla JavaScript. To test:
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this directory

## Architecture

```
content.js (injected) ←──→ background.js (service worker)
       ↓
  Floating Toolbar UI (DOM injection)
       ↓
  Web Speech API (speechSynthesis)
```

**Key state:**
- `segments[]` - extracted text content split into chunks
- `segmentElements[]` - DOM element references for each segment
- `currentIndex` - currently playing segment index

**Key functions:**
- `extractPageContent()` - uses TreeWalker to extract visible text nodes from main content container
- `findElementBySegmentText(text)` - re-locates DOM element by text content (for dynamic pages)
- `scrollToSegment(index)` - scrolls to and highlights page element
- `splitLongSegment(text, maxLength)` - splits text at 700 chars for TTS stability

**Content extraction flow:**
1. Find main content container (article, main, .markdown-section, etc.)
2. Use TreeWalker to traverse visible text nodes
3. Group by block elements (p, div, h1-h6, li, etc.)
4. Split long segments at 700 characters
5. Merge adjacent short segments (<50 chars)

**Navigation filtering:** `isNavigationElement()` excludes sidebar, nav, menu, header, footer, toolbar, search, toc elements.

## Files

- `manifest.json` - Extension manifest V3
- `content.js` - Main logic (injected into pages)
- `content.css` - Floating toolbar styles
- `background.js` - Simplified service worker for storage
- `icons/` - Extension icons (16/32/48/128px)
- `SPEC.md` - Design specification (popup-based, outdated; actual UI is floating toolbar)