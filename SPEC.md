# Text-to-Speech Browser Extension Specification

## 1. Project Overview

- **Project Name**: Page Reader (页面朗读助手)
- **Core Functionality**: A browser extension that extracts text content from web pages, segments it into manageable sections, and plays it back using the browser's native Web Speech API.
- **Target Users**: Users who prefer listening to web content rather than reading, or those who want hands-free browsing.

## 2. Technical Stack

- **Browser Support**: Chrome/Edge (Chromium-based)
- **Speech Engine**: Web Speech API (browser-native TTS)
- **Extension Manifest**: V3
- **No external dependencies** - pure vanilla JavaScript

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Browser Extension                       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │  Popup UI   │◄──►│  Background │◄──►│Content Script│ │
│  │  (HTML/CSS) │    │   Script    │    │  (Page DOM)  │ │
│  └─────────────┘    └─────────────┘    └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Components

1. **popup.html/css/js** - Extension popup UI with playback controls
2. **background.js** - Background service worker for message passing
3. **content.js** - Injected into web pages to extract text content
4. **manifest.json** - Extension configuration

## 4. UI/UX Specification

### 4.1 Popup Window

**Dimensions**: 320px × 400px (fixed)

**Layout Structure**:

```
┌────────────────────────────────────┐
│  Header                            │
│  ┌────────────────────────────────┐│
│  │ 📖 页面朗读助手                 ││
│  └────────────────────────────────┘│
├────────────────────────────────────┤
│  Page Info                         │
│  ┌────────────────────────────────┐│
│  │ 页面标题: xxx                   ││
│  │ 文字段落: X 段                  ││
│  └────────────────────────────────┘│
├────────────────────────────────────┤
│  Segment Navigation                │
│  ┌────────────────────────────────┐│
│  │  [◀ 上一段]  第 X/Y 段  [下一段 ▶]││
│  └────────────────────────────────┘│
├────────────────────────────────────┤
│  Current Segment Preview           │
│  ┌────────────────────────────────┐│
│  │                                ││
│  │  (当前段落的文字预览，限制3行)    ││
│  │                                ││
│  └────────────────────────────────┘│
├────────────────────────────────────┤
│  Playback Controls                 │
│  ┌────────────────────────────────┐│
│  │  [▶ 播放]  [⏸ 暂停]  [⏹ 停止]   ││
│  └────────────────────────────────┘│
├────────────────────────────────────┤
│  Voice Settings                    │
│  ┌────────────────────────────────┐│
│  │ 语速: [━━━●━━━] 1.0x           ││
│  │ 音调: [━━━●━━━] 1.0           ││
│  │ 语音: [▼ 选择语音]             ││
│  └────────────────────────────────┘│
└────────────────────────────────────┘
```

### 4.2 Color Palette

| Element       | Color     | Hex Code  |
|---------------|-----------|-----------|
| Primary       | Deep Blue | `#2563EB` |
| Primary Hover | Blue      | `#1D4ED8` |
| Secondary     | Slate     | `#64748B` |
| Background    | White     | `#FFFFFF` |
| Surface       | Light Gray| `#F8FAFC` |
| Border        | Gray      | `#E2E8F0` |
| Text Primary  | Dark Slate| `#1E293B` |
| Text Secondary| Gray      | `#64748B` |
| Success       | Green     | `#22C55E` |
| Error         | Red       | `#EF4444` |

### 4.3 Typography

- **Font Family**: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Header**: 16px, font-weight 600
- **Body**: 14px, font-weight 400
- **Caption**: 12px, font-weight 400
- **Line Height**: 1.5

### 4.4 Spacing System

- Base unit: 4px
- Padding small: 8px
- Padding medium: 12px
- Padding large: 16px
- Border radius: 8px (buttons), 6px (cards)

### 4.5 Component States

**Buttons**:
- Default: Background `#2563EB`, text white
- Hover: Background `#1D4ED8`
- Active: Background `#1E40AF`
- Disabled: Background `#94A3B8`, cursor not-allowed

**Navigation Buttons**:
- Default: Background `#F1F5F9`, text `#64748B`
- Hover: Background `#E2E8F0`

**Range Sliders**:
- Track: Background `#E2E8F0`, height 4px
- Thumb: Background `#2563EB`, size 16px

## 5. Functionality Specification

### 5.1 Core Features

1. **Page Text Extraction**
   - Extract all readable text content from the page
   - Split content into semantic paragraphs
   - Filter out navigation, scripts, styles, and hidden elements
   - Maximum 50 segments per page (for performance)

2. **Text Segmentation**
   - Split by paragraph (`<p>` tags)
   - Further split long paragraphs (>500 chars) by sentence
   - Each segment limited to 300 characters for optimal TTS

3. **Playback Controls**
   - **Play**: Start/resume TTS playback of current segment
   - **Pause**: Pause current playback
   - **Stop**: Stop playback and reset to segment 1
   - **Previous/Next Segment**: Navigate between segments

4. **Voice Settings**
   - **Rate** (Speed): 0.5x to 2.0x, default 1.0x
   - **Pitch**: 0.5 to 2.0, default 1.0
   - **Voice Selection**: List available system voices

### 5.2 User Interactions

1. Click extension icon → Popup opens, auto-extract page content
2. Content displays: page title, segment count, first segment preview
3. User clicks Play → TTS speaks current segment
4. Speaking completes → Auto-advance to next segment
5. User can manually navigate segments while paused
6. Settings persist across sessions (localStorage)

### 5.3 Data Flow

```
[Popup Opens]
     │
     ▼
[Send message to content script]
     │
     ▼
[Extract page text → Segment into array]
     │
     ▼
[Return segments + metadata to popup]
     │
     ▼
[User controls playback]
     │
     ▼
[Use Web Speech API.speak() to play]
```

### 5.4 Edge Cases

- **Empty page**: Show message "未检测到可朗读内容"
- **No speech support**: Show error "您的浏览器不支持语音合成"
- **Single segment**: Hide prev/next navigation
- **First segment**: Disable "上一段" button
- **Last segment**: Disable "下一段" button
- **Speaking while navigating**: Stop current speech before switching

## 6. File Structure

```
text-to-speech-extension/
├── manifest.json          # Extension manifest V3
├── popup.html            # Popup UI
├── popup.css             # Popup styles
├── popup.js              # Popup logic
├── background.js         # Background service worker
├── content.js            # Content script (injected)
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── SPEC.md
```

## 7. Manifest Configuration

```json
{
  "manifest_version": 3,
  "name": "页面朗读助手",
  "version": "1.0.0",
  "description": "将网页文字转换为语音播放",
  "permissions": ["activeTab", "storage"],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "background": {
    "service_worker": "background.js"
  }
}
```

## 8. Acceptance Criteria

1. ✅ Extension installs successfully on Chrome/Edge
2. ✅ Popup displays page title and segment count
3. ✅ Text is correctly extracted and segmented
4. ✅ Play/Pause/Stop controls work correctly
5. ✅ Navigation between segments works
6. ✅ Voice settings (rate, pitch, voice) affect playback
7. ✅ Settings persist after closing popup
8. ✅ Handles edge cases gracefully (empty page, no TTS support)
9. ✅ Clean, professional UI matching spec colors and typography
