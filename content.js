/**
 * content.js - 页面朗读助手（悬浮工具条版）
 * 注入到每个页面，负责提取文字、显示悬浮工具条、播放 TTS、段落高亮
 */

(function () {
  'use strict';

  // ============ 常量定义 ============
  const MAX_SEGMENTS = 100;  // 增加最大段落数
  const MAX_PREVIEW_CHARS = 150;
  const DEBOUNCE_DELAY = 300;
  const PREVIEW_HIGHLIGHT_DURATION = 2000;

  // ============ 状态 ============
  let segments = [];
  let segmentElements = [];  // 保存每个段落对应的 DOM 元素
  let currentIndex = 0;
  let isPlaying = false;
  let isPaused = false;
  let speechSynth = window.speechSynthesis || null;
  let currentUtterance = null;
  let currentUtteranceId = 0;
  let lastScrolledIndex = -1;  // 记录上次滚动到的段落索引
  let voices = [];
  let waitForVoicesRetryCount = 0;
  const MAX_VOICE_WAIT_RETRIES = 50;
  let isInitialized = false;  // 防止重复初始化
  const floatingBarId = 'tts-floating-bar';
  let previewClickTimeout = null;  // 预览点击防抖
  let waitForVoicesTimeout = null;  // 语音等待超时 ID
  let lastSegmentListHash = '';  // 上次渲染的段落列表哈希，用于避免重复渲染
  let contentCheckRetryCount = 0;  // 内容检测重试次数
  const MAX_CONTENT_CHECK_RETRIES = 40;  // 增加最大重试次数
  let contentCheckTimeout = null;  // 内容检测 timeout ID
  let contentObserver = null;  // MutationObserver
  let settings = {
    rate: 1.0,
    pitch: 1.0,
    voiceName: ''
  };

  // ============ 工具函数 ============

  /**
   * 检查元素是否是导航/脚手架元素
   */
  function isNavigationElement(el) {
    const classAndId = (el.className || '') + ' ' + (el.id || '');
    const navKeywords = ['sidebar', 'nav', 'menu', 'header', 'footer', 'toolbar', 'breadcrumb', 'pagination', 'search', 'toc', 'outline', 'dropdown', 'sidebar', 'toc'];
    // 检查是否是 docsify 的侧边栏项目
    const isSidebarItem = el.closest && el.closest('.sidebar, .sidebar-nav, [class*="sidebar"]');
    return navKeywords.some(keyword => classAndId.toLowerCase().includes(keyword)) || isSidebarItem;
  }

  /**
   * 按文本内容查找页面对应的 DOM 元素
   */
  function findElementBySegmentText(text) {
    const needle = cleanText(text).slice(0, 80);
    if (!needle) return null;

    const candidates = document.body.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, figcaption, div, section'
    );

    return Array.from(candidates).find(el => {
      if (isNavigationElement(el)) return false;
      return cleanText(el.innerText || el.textContent || '').includes(needle);
    }) || null;
  }

  /**
   * 滚动到指定段落并高亮
   */
  function scrollToSegment(index, behavior = 'smooth') {
    let element = segmentElements[index];

    if (!element || !document.contains(element)) {
      element = findElementBySegmentText(segments[index]);
      segmentElements[index] = element;
    }

    if (!element || !document.contains(element)) {
      showStatus('未找到页面中的对应段落', 'info');
      return false;
    }

    element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    element.classList.add('tts-highlight-active', 'tts-scroll-to-highlight');
    lastScrolledIndex = index;
    return true;
  }

  /**
   * 清理文本
   */
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')
      .replace(/[\r\n]+/g, '\n')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .trim();
  }

  /**
   * 分割长段落 - 只在超过2000字符时按句子分割
   */
  function splitLongSegment(text, maxLength = 2000) {
    if (!text || text.length === 0) return [];
    if (text.length <= maxLength) {
      return [text];
    }

    // 长文本按句子分割，但保持句子完整性
    const sentences = text.match(/[^.!?。！？]+[.!?。！？]+/g) || [text];
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length <= maxLength) {
        currentChunk += sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        // 如果单个句子超过maxLength，直接加入（不做截断）
        currentChunk = sentence;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * 从页面提取文本内容
   */
  function extractPageContent() {
    const pageTitle = document.title || '无标题页面';

    // 提取段落并记录对应的 DOM 元素
    const paragraphs = [];
    segmentElements = [];

    // 优先查找主内容容器
    const contentSelectors = [
      'article',
      'main',
      '[role="main"]',
      '.markdown-section',
      '.content',
      '.post-content',
      '.doc-content',
      '#content',
      '#main',
      '.markdown-body'
    ];

    let contentContainer = null;
    let maxTextLength = 0;

    // 找到文字量最大的主内容容器
    for (const selector of contentSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const textLength = el.textContent.length;
        if (textLength > maxTextLength) {
          maxTextLength = textLength;
          contentContainer = el;
        }
      }
    }

    // 如果没找到，回退到 body
    if (!contentContainer) {
      contentContainer = document.body;
    }

    // 用 TreeWalker 遍历可见文本节点
    const textNodes = [];
    const walker = document.createTreeWalker(
      contentContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // 跳过空白文本和无内容元素
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          // 跳过 script、style 等元素
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tagName = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // 按块级元素归组文本
    let currentBlock = null;
    let currentText = '';

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;

      // 最近的块级元素
      const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'pre', 'article', 'section'];
      let block = null;
      let el = parent;
      while (el && el !== contentContainer) {
        if (blockElements.includes(el.tagName.toLowerCase())) {
          block = el;
          break;
        }
        el = el.parentElement;
      }

      if (block !== currentBlock) {
        // 保存之前的文本
        if (currentText.trim().length > 5 && currentBlock && !isNavigationElement(currentBlock)) {
          paragraphs.push(currentText.trim());
          segmentElements.push(currentBlock);
        }
        currentBlock = block;
        currentText = node.textContent;
      } else {
        currentText += ' ' + node.textContent;
      }
    }
    // 保存最后一段
    if (currentText.trim().length > 5 && currentBlock && !isNavigationElement(currentBlock)) {
      paragraphs.push(currentText.trim());
      segmentElements.push(currentBlock);
    }

    // 如果段落少于 2 个，尝试从 body 直接提取
    if (paragraphs.length < 2) {
      const bodyText = cleanText(document.body ? document.body.innerText : '');
      if (bodyText.length > 5) {
        // 按句子分割
        const sentences = bodyText.match(/[^.!?。！？\n]+[.!?。！？\n]*/g);
        if (sentences) {
          sentences.forEach(line => {
            const cleanedLine = cleanText(line);
            if (cleanedLine.length > 5) {
              paragraphs.push(cleanedLine);
              segmentElements.push(null);
            }
          });
        } else {
          // 按换行分割
          const lines = bodyText.split(/\n+/).filter(line => cleanText(line).length > 5);
          paragraphs.push(...lines.map(l => cleanText(l)));
          segmentElements.push(...lines.map(() => null));
        }
      }
    }

    // 分割长段落（按 700 字符分段，避免超长段落导致 TTS 不稳定）
    const allChunks = [];
    const allElements = [];
    paragraphs.forEach((para, idx) => {
      const chunks = splitLongSegment(para, 700);  // 降低到 700 字符
      allChunks.push(...chunks);
      // 每个 chunk 对应同一个元素
      chunks.forEach(() => allElements.push(segmentElements[idx]));
    });

    // 合并相邻过短段落（< 50字符），保留元素引用
    const mergedChunks = [];
    const mergedElements = [];
    let tempChunk = '';
    let tempElement = null;

    for (let i = 0; i < allChunks.length; i++) {
      const chunk = allChunks[i];
      const element = allElements[i];

      if (chunk.length < 50 && tempChunk.length > 0 && tempElement === element) {
        // 相同元素的短段落，合并到上一个段落
        tempChunk += ' ' + chunk;
      } else {
        // 保存之前的段落
        if (tempChunk.length > 0) {
          mergedChunks.push(tempChunk);
          mergedElements.push(tempElement);
        }
        tempChunk = chunk;
        tempElement = element;
      }
    }
    // 保存最后一段
    if (tempChunk.length > 0) {
      mergedChunks.push(tempChunk);
      mergedElements.push(tempElement);
    }

    segments = mergedChunks;
    segmentElements = mergedElements;

    return {
      success: true,
      title: pageTitle,
      segments: segments,
      totalSegments: segments.length
    };
  }

  // ============ UI 创建 ============

  function createFloatingBar() {
    // 创建容器
    const container = document.createElement('div');
    container.className = 'tts-floating-bar collapsed';
    container.id = 'tts-floating-bar';

    // 切换按钮
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tts-toggle-btn';
    toggleBtn.innerHTML = '📖';
    toggleBtn.title = '页面朗读助手';
    toggleBtn.addEventListener('click', togglePanel);

    // 面板
    const panel = document.createElement('div');
    panel.className = 'tts-panel';

    // 头部
    const header = document.createElement('div');
    header.className = 'tts-panel-header';
    header.innerHTML = `
      <span class="tts-panel-title">📖 页面朗读助手</span>
      <button class="tts-close-btn" id="tts-close-btn">−</button>
    `;
    panel.appendChild(header);

    // 页面信息
    const pageInfo = document.createElement('div');
    pageInfo.className = 'tts-page-info';
    pageInfo.innerHTML = `
      <div class="tts-page-title" id="tts-page-title">加载中...</div>
      <div class="tts-segment-count" id="tts-segment-count">0 段</div>
    `;
    panel.appendChild(pageInfo);

    // 导航
    const nav = document.createElement('div');
    nav.className = 'tts-navigation';
    nav.innerHTML = `
      <button class="tts-nav-btn" id="tts-prev-btn" disabled>◀ 上一段</button>
      <span class="tts-nav-indicator" id="tts-nav-indicator">第 0/0 段</span>
      <button class="tts-nav-btn" id="tts-next-btn" disabled>下一段 ▶</button>
    `;
    panel.appendChild(nav);

    // 预览
    const preview = document.createElement('div');
    preview.className = 'tts-preview';
    preview.style.cursor = 'pointer';
    preview.title = '点击跳转到页面中的对应段落';
    preview.innerHTML = `
      <div class="tts-preview-content" id="tts-preview-content">点击播放按钮开始朗读</div>
      <div class="tts-preview-hint">点击预览区域跳转到页面对应段落</div>
    `;
    preview.addEventListener('click', () => {
      // 防抖：清除之前的 timeout
      if (previewClickTimeout) {
        clearTimeout(previewClickTimeout);
        previewClickTimeout = null;
      }

      scrollToSegment(currentIndex);

      // 2秒后移除临时高亮
      const element = segmentElements[currentIndex];
      if (element && document.contains(element)) {
        const elementToClean = element;
        previewClickTimeout = setTimeout(() => {
          previewClickTimeout = null;
          if (elementToClean && document.contains(elementToClean)) {
            elementToClean.classList.remove('tts-highlight-active', 'tts-scroll-to-highlight');
            updateHighlight();
          }
        }, PREVIEW_HIGHLIGHT_DURATION);
      }
    });
    panel.appendChild(preview);

    // 段落列表
    const segmentList = document.createElement('div');
    segmentList.className = 'tts-segment-list';
    segmentList.id = 'tts-segment-list';
    segmentList.innerHTML = '<div class="tts-segment-list-title">朗读列表</div><div class="tts-segment-items" id="tts-segment-items"></div>';
    panel.appendChild(segmentList);

    // 控制按钮
    const controls = document.createElement('div');
    controls.className = 'tts-controls';
    controls.innerHTML = `
      <button class="tts-control-btn tts-play-btn" id="tts-play-btn" disabled>▶ 播放</button>
      <button class="tts-control-btn tts-secondary-btn" id="tts-pause-btn" disabled>⏸ 暂停</button>
      <button class="tts-control-btn tts-secondary-btn" id="tts-stop-btn" disabled>⏹ 停止</button>
    `;
    panel.appendChild(controls);

    // 设置
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'tts-settings';
    settingsPanel.innerHTML = `
      <div class="tts-setting-row">
        <label class="tts-setting-label">语速</label>
        <input type="range" id="tts-rate-slider" min="0.5" max="2" step="0.1" value="1">
        <span class="tts-setting-value" id="tts-rate-value">1.0x</span>
      </div>
      <div class="tts-setting-row">
        <label class="tts-setting-label">音调</label>
        <input type="range" id="tts-pitch-slider" min="0.5" max="2" step="0.1" value="1">
        <span class="tts-setting-value" id="tts-pitch-value">1.0</span>
      </div>
      <div class="tts-setting-row">
        <label class="tts-setting-label">语音</label>
        <select id="tts-voice-select"><option value="">加载中...</option></select>
      </div>
    `;
    panel.appendChild(settingsPanel);

    // 状态
    const status = document.createElement('div');
    status.className = 'tts-status';
    status.id = 'tts-status';
    panel.appendChild(status);

    container.appendChild(panel);
    container.appendChild(toggleBtn);
    document.body.appendChild(container);

    // 绑定事件
    bindEvents();
  }

  function bindEvents() {
    document.getElementById('tts-close-btn').addEventListener('click', togglePanel);
    document.getElementById('tts-prev-btn').addEventListener('click', prevSegment);
    document.getElementById('tts-next-btn').addEventListener('click', nextSegment);
    document.getElementById('tts-play-btn').addEventListener('click', play);
    document.getElementById('tts-pause-btn').addEventListener('click', pause);
    document.getElementById('tts-stop-btn').addEventListener('click', stop);

    const rateSlider = document.getElementById('tts-rate-slider');
    const pitchSlider = document.getElementById('tts-pitch-slider');
    const voiceSelect = document.getElementById('tts-voice-select');

    rateSlider.addEventListener('input', () => {
      document.getElementById('tts-rate-value').textContent = parseFloat(rateSlider.value).toFixed(1) + 'x';
      settings.rate = parseFloat(rateSlider.value);
      saveSettings();
    });

    pitchSlider.addEventListener('input', () => {
      document.getElementById('tts-pitch-value').textContent = parseFloat(pitchSlider.value).toFixed(1);
      settings.pitch = parseFloat(pitchSlider.value);
      saveSettings();
    });

    voiceSelect.addEventListener('change', () => {
      settings.voiceName = voiceSelect.value;
      saveSettings();
    });
  }

  function togglePanel() {
    const bar = document.getElementById('tts-floating-bar');
    bar.classList.toggle('collapsed');
    bar.classList.toggle('expanded');
  }

  // ============ TTS 功能 ============

  function loadVoices() {
    voices = speechSynth.getVoices();
    const voiceSelect = document.getElementById('tts-voice-select');
    if (!voiceSelect) return;
    voiceSelect.innerHTML = '';

    if (voices.length === 0) {
      voiceSelect.innerHTML = '<option value="">无可用语音</option>';
      return;
    }

    const chineseVoices = voices.filter(v => v.lang.includes('zh'));
    const otherVoices = voices.filter(v => !v.lang.includes('zh'));

    chineseVoices.forEach(voice => {
      const opt = document.createElement('option');
      opt.value = voice.name;
      opt.textContent = `[中文] ${voice.name}`;
      voiceSelect.appendChild(opt);
    });

    otherVoices.forEach(voice => {
      const opt = document.createElement('option');
      opt.value = voice.name;
      opt.textContent = `${voice.name}`;
      voiceSelect.appendChild(opt);
    });

    // 恢复保存的语音设置
    chrome.storage.local.get(['voiceName'], (result) => {
      if (result.voiceName && voices.find(v => v.name === result.voiceName)) {
        voiceSelect.value = result.voiceName;
        settings.voiceName = result.voiceName;
      } else if (chineseVoices.length > 0) {
        voiceSelect.value = chineseVoices[0].name;
        settings.voiceName = chineseVoices[0].name;
      }
    });
  }

  function saveSettings() {
    chrome.storage.local.set(settings, () => {
      if (chrome.runtime.lastError) {
        console.warn('设置保存失败:', chrome.runtime.lastError);
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get({
      rate: 1.0,
      pitch: 1.0,
      voiceName: ''
    }, (result) => {
      settings = {
        rate: result.rate || 1.0,
        pitch: result.pitch || 1.0,
        voiceName: result.voiceName || ''
      };
      const rateSlider = document.getElementById('tts-rate-slider');
      const pitchSlider = document.getElementById('tts-pitch-slider');
      if (rateSlider) rateSlider.value = settings.rate;
      if (pitchSlider) pitchSlider.value = settings.pitch;
      document.getElementById('tts-rate-value').textContent = settings.rate.toFixed(1) + 'x';
      document.getElementById('tts-pitch-value').textContent = settings.pitch.toFixed(1);
    });
  }

  function showStatus(message, type = 'error') {
    const status = document.getElementById('tts-status');
    if (!status) return;
    status.textContent = message;
    status.className = 'tts-status ' + type;
    setTimeout(() => {
      status.className = 'tts-status';
    }, 3000);
  }

  function updateUI() {
    const prevBtn = document.getElementById('tts-prev-btn');
    const nextBtn = document.getElementById('tts-next-btn');
    const playBtn = document.getElementById('tts-play-btn');
    const pauseBtn = document.getElementById('tts-pause-btn');
    const stopBtn = document.getElementById('tts-stop-btn');
    const navIndicator = document.getElementById('tts-nav-indicator');
    const previewContent = document.getElementById('tts-preview-content');

    if (!prevBtn || !playBtn) return;

    if (segments.length === 0) {
      if (navIndicator) navIndicator.textContent = '第 0/0 段';
      if (previewContent) previewContent.textContent = '点击播放按钮开始朗读';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (playBtn) playBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      return;
    }

    const total = segments.length;
    const current = currentIndex + 1;

    if (navIndicator) navIndicator.textContent = `第 ${current}/${total} 段`;
    if (previewContent) previewContent.textContent = truncateText(segments[currentIndex], MAX_PREVIEW_CHARS);

    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.disabled = currentIndex === total - 1;
    if (playBtn) playBtn.disabled = false;
    if (pauseBtn) pauseBtn.disabled = !isPlaying;
    if (stopBtn) stopBtn.disabled = !isPlaying && !isPaused;

    if (playBtn) {
      if (isPlaying) {
        playBtn.innerHTML = '▶ 播放中';
        playBtn.classList.add('playing');
      } else {
        playBtn.innerHTML = '▶ 播放';
        playBtn.classList.remove('playing');
      }
    }

    // 更新高亮
    updateHighlight();
    renderSegmentList();
  }

  function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  function renderSegmentList() {
    const container = document.getElementById('tts-segment-items');
    if (!container) return;

    // 检查是否有变化，避免不必要的重绘
    const currentHash = segments.map((s, i) => `${i}:${s.substring(0, 20)}:${i === currentIndex}`).join('|');
    if (currentHash === lastSegmentListHash && container.children.length === segments.length) {
      // 内容没变，只更新当前项的激活状态
      container.querySelectorAll('.tts-segment-item').forEach((item, idx) => {
        if (idx === currentIndex) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
      const activeItem = container.querySelector('.tts-segment-item.active');
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }
    lastSegmentListHash = currentHash;

    // 使用 DocumentFragment 减少 DOM 操作次数
    const fragment = document.createDocumentFragment();

    if (segments.length === 0) {
      container.innerHTML = '<div class="tts-segment-empty">无可朗读内容</div>';
      return;
    }

    segments.forEach((text, idx) => {
      const item = document.createElement('div');
      item.className = 'tts-segment-item' + (idx === currentIndex ? ' active' : '');
      // 显示截断文本，但用 title 属性保存完整文本，明确只做预览
      item.textContent = `${idx + 1}. ${truncateText(text, 60)}`;
      item.title = text;  // 鼠标悬停显示完整文本
      item.addEventListener('click', () => {
        if (isPlaying) {
          stop();
        }
        currentIndex = idx;
        lastScrolledIndex = -1;
        scrollToSegment(idx);
        updateUI();
        play();
      });
      fragment.appendChild(item);
    });

    // 一次性替换容器内容
    container.textContent = '';
    container.appendChild(fragment);

    // 滚动到当前项
    const activeItem = container.querySelector('.tts-segment-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function updateHighlight() {
    // 清除所有高亮
    document.querySelectorAll('.tts-highlight, .tts-highlight-active').forEach(el => {
      el.classList.remove('tts-highlight', 'tts-highlight-active', 'tts-scroll-to-highlight');
    });

    // 高亮当前段落（检查元素是否存在，可能被页面动态移除）
    const element = segmentElements[currentIndex];
    if (element && document.contains(element)) {
      element.classList.add('tts-highlight-active');
      element.classList.add('tts-scroll-to-highlight');

      // 只在段落变化时滚动，避免每次更新都跳
      if (currentIndex !== lastScrolledIndex) {
        lastScrolledIndex = currentIndex;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      // 元素已被移除，尝试找到下一个有效元素
      segmentElements[currentIndex] = null;
    }
  }

  function play() {
    if (segments.length === 0) return;
    if (!speechSynth) {
      showStatus('您的浏览器不支持语音合成');
      return;
    }

    // 确保语音已加载
    if (voices.length === 0) {
      showStatus('语音加载中，请稍候...', 'info');
      loadVoices();
      if (voices.length === 0) {
        // 等待语音加载
        const waitAndPlay = () => {
          if (voices.length > 0) {
            play();
          }
        };
        waitForVoicesTimeout = setTimeout(waitAndPlay, 500);
        return;
      }
    }

    // 停止当前播放（只调用一次）
    if (isPlaying) {
      speechSynth.cancel();
      isPlaying = false;
      isPaused = false;
      currentUtterance = null;
    }

    if (isPaused && currentUtterance) {
      speechSynth.resume();
      isPaused = false;
      isPlaying = true;
      updateUI();
      return;
    }

    const text = segments[currentIndex];
    const thisUtteranceId = ++currentUtteranceId;

    currentUtterance = new SpeechSynthesisUtterance(text);
    currentUtterance.rate = Math.max(0.1, Math.min(10, settings.rate || 1.0));
    currentUtterance.pitch = Math.max(0, Math.min(2, settings.pitch || 1.0));

    if (settings.voiceName) {
      const voice = voices.find(v => v.name === settings.voiceName);
      if (voice) currentUtterance.voice = voice;
    }

    currentUtterance.onend = () => {
      if (thisUtteranceId !== currentUtteranceId) return;
      isPlaying = false;
      isPaused = false;  // 重置暂停状态
      currentUtterance = null;

      // 自动播放下一段
      if (currentIndex < segments.length - 1) {
        currentIndex++;
        updateUI();
        // 直接调用 play()，不使用 setTimeout 避免延迟问题
        play();
      } else {
        updateUI();
      }
    };

    currentUtterance.onerror = (event) => {
      if (thisUtteranceId !== currentUtteranceId) return;
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        showStatus('朗读出错: ' + event.error);
      }
      isPlaying = false;
      currentUtterance = null;
      updateUI();
    };

    isPlaying = true;
    isPaused = false;
    speechSynth.speak(currentUtterance);
    updateUI();
  }

  function pause() {
    if (!isPlaying) return;
    speechSynth.pause();
    isPaused = true;
    isPlaying = false;
    updateUI();
  }

  function stop() {
    speechSynth.cancel();
    isPlaying = false;
    isPaused = false;
    currentUtterance = null;
    updateUI();
  }

  function prevSegment() {
    if (currentIndex > 0) {
      stop();
      currentIndex--;
      updateUI();
    }
  }

  function nextSegment() {
    if (currentIndex < segments.length - 1) {
      stop();
      currentIndex++;
      updateUI();
    }
  }

  // ============ 初始化 ============

  function init() {
    // 防止重复初始化
    if (isInitialized) return;
    isInitialized = true;

    // 检查 speechSynth 是否可用
    if (!speechSynth) {
      console.warn('页面朗读助手：您的浏览器不支持语音合成');
      return;
    }

    // 检查是否已存在浮动工具条（防止重复）
    if (document.getElementById(floatingBarId)) {
      return;
    }

    // 创建 UI
    createFloatingBar();

    // 提取内容
    const result = extractPageContent();

    if (result.success) {
      const titleEl = document.getElementById('tts-page-title');
      const countEl = document.getElementById('tts-segment-count');
      if (titleEl) titleEl.textContent = truncateText(result.title, 20);
      if (countEl) countEl.textContent = `${result.totalSegments} 段`;
    }

    // 重置语音等待计数
    waitForVoicesRetryCount = 0;

    // 加载语音和设置
    loadSettings();

    if (speechSynth.onvoiceschanged !== undefined) {
      speechSynth.onvoiceschanged = loadVoices;
    }

    const waitForVoices = () => {
      loadVoices();
      if (voices.length === 0 && waitForVoicesRetryCount < MAX_VOICE_WAIT_RETRIES) {
        waitForVoicesRetryCount++;
        waitForVoicesTimeout = setTimeout(waitForVoices, 100);
      }
    };
    loadVoices();
    if (voices.length === 0) waitForVoices();

    updateUI();
    renderSegmentList();

    // 页面卸载时清理
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);
  }

  function cleanup() {
    // 停止语音
    if (speechSynth) {
      speechSynth.cancel();
    }
    // 清除待处理的 setTimeout
    if (previewClickTimeout) {
      clearTimeout(previewClickTimeout);
      previewClickTimeout = null;
    }
    if (waitForVoicesTimeout) {
      clearTimeout(waitForVoicesTimeout);
      waitForVoicesTimeout = null;
    }
    if (contentCheckTimeout) {
      clearTimeout(contentCheckTimeout);
      contentCheckTimeout = null;
    }
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }
    // 移除事件监听器
    window.removeEventListener('beforeunload', cleanup);
    window.removeEventListener('pagehide', cleanup);
    // 移除浮动工具条
    const bar = document.getElementById(floatingBarId);
    if (bar) {
      bar.remove();
    }
    // 清除高亮
    document.querySelectorAll('.tts-highlight, .tts-highlight-active').forEach(el => {
      el.classList.remove('tts-highlight', 'tts-highlight-active', 'tts-scroll-to-highlight');
    });
    // 重置状态
    isInitialized = false;
  }

  // 初始化内容提取和重试逻辑（用于动态加载的页面如 docsify）
  let lastContentLength = 0;
  let stableCount = 0;
  const STABILITY_THRESHOLD = 4;  // 连续 4 次检测内容长度不变则认为稳定（2 秒）

  function extractContentWithRetry() {
    const result = extractPageContent();
    const currentLength = result.totalSegments;

    // 检查内容是否稳定（2秒内不再变化）
    if (currentLength === lastContentLength && currentLength > 0) {
      stableCount++;
    } else {
      stableCount = 0;
      lastContentLength = currentLength;
    }

    if (result.success && result.totalSegments > 0) {
      // 成功提取到内容
      const titleEl = document.getElementById('tts-page-title');
      const countEl = document.getElementById('tts-segment-count');
      if (titleEl) titleEl.textContent = truncateText(result.title, 20);
      if (countEl) countEl.textContent = `${result.totalSegments} 段`;
      updateUI();
      renderSegmentList();

      // 如果内容已经稳定，停止 MutationObserver
      if (stableCount >= STABILITY_THRESHOLD) {
        if (contentObserver) {
          contentObserver.disconnect();
          contentObserver = null;
        }
      }
      return true;
    }

    // 内容为空，继续等待
    if (contentCheckRetryCount < MAX_CONTENT_CHECK_RETRIES) {
      contentCheckRetryCount++;
      contentCheckTimeout = setTimeout(extractContentWithRetry, 500);
      return false;
    }

    // 达到最大重试次数，启用 MutationObserver 监听内容变化
    if (!contentObserver) {
      contentObserver = new MutationObserver((mutations) => {
        // 内容变化时尝试重新提取
        contentCheckRetryCount = 0;
        stableCount = 0;
        extractContentWithRetry();
      });
      contentObserver.observe(document.body, { childList: true, subtree: true });
    }
    return false;
  }

  // 启动
  if (document.readyState === 'complete') {
    init();
    // 对于动态加载的页面，延迟 1 秒后尝试提取内容
    setTimeout(extractContentWithRetry, 1000);
  } else {
    window.addEventListener('load', () => {
      init();
      // 对于动态加载的页面，延迟 1 秒后尝试提取内容
      setTimeout(extractContentWithRetry, 1000);
    });
  }
})();
